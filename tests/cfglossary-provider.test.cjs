const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const {
  AuthService,
} = require('../apps/backend/dist/libraries/helpers/src/auth/auth.service.js');
const {
  CrawlFoundryGlossaryProvider,
} = require('../apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/cfglossary.provider.js');

const originalFetch = global.fetch;
const originalDecrypt = AuthService.fixedDecryption;
const termId = 'dc2a6421-24fc-47e9-9f31-ec4accb20959';
const post = { id: 'post-1', settings: { termId, termTitle: 'Example' } };
const integration = { customInstanceDetails: 'encrypted' };

process.env.CRAWL_FOUNDRY_DIRECTUS_URL = 'http://directus:8055';
process.env.CRAWL_FOUNDRY_REVALIDATION_SECRET = 'test-only-secret';
AuthService.fixedDecryption = () =>
  JSON.stringify({ url: 'http://directus:8055', token: 'test-only-token' });

afterEach(() => {
  global.fetch = originalFetch;
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch({ releasedAt = null, noIndex = false, parentStatus = 'active' } = {}) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/items/glossary_entries/') && init.method === 'PATCH') {
      return response({ data: { id: termId } });
    }
    if (url.includes('/items/glossary_entries/')) {
      return response({
        data: {
          id: termId,
          status: parentStatus,
          discovery_released_at: releasedAt,
        },
      });
    }
    if (url.includes('/items/glossary_entries_translations?')) {
      return response({
        data: [
          {
            id: 'de-id',
            title: 'Begriff',
            slug: 'keyword-placement',
            status: 'published',
            no_index: noIndex,
            sitemap_included: true,
            release_channel: 'production',
            language: { code: 'de' },
          },
          {
            id: 'en-id',
            title: 'Term',
            slug: 'keyword-placement',
            status: 'published',
            no_index: false,
            sitemap_included: true,
            release_channel: 'production',
            language: { code: 'en' },
          },
        ],
      });
    }
    if (url.endsWith('/api/directus/revalidate')) {
      return response({ revalidatedPaths: ['/de/glossary/keyword-placement'] });
    }
    if (url.endsWith('/de/glossary/keyword-placement')) {
      return new Response('<meta name="robots" content="index, follow">');
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return calls;
}

test('releases one active term, revalidates the website, and returns its URL', async () => {
  const calls = mockFetch();
  const result = await new CrawlFoundryGlossaryProvider().post(
    '',
    '',
    [post],
    integration,
  );
  assert.equal(result[0].status, 'completed');
  assert.equal(result[0].releaseURL, 'https://crawlfoundry.com/de/glossary/keyword-placement');
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(calls.find((call) => call.method === 'PATCH').body.includes('discovery_released_at'));
});

test('retries revalidation without a second CMS release write', async () => {
  const calls = mockFetch({ releasedAt: '2026-10-01T04:00:00Z' });
  await new CrawlFoundryGlossaryProvider().post('', '', [post], integration);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('rejects archived or noindex content before changing the CMS', async () => {
  const archivedCalls = mockFetch({ parentStatus: 'archived' });
  await assert.rejects(
    new CrawlFoundryGlossaryProvider().post('', '', [post], integration),
    /not active/,
  );
  assert.equal(archivedCalls.filter((call) => call.method === 'PATCH').length, 0);

  const noIndexCalls = mockFetch({ noIndex: true });
  await assert.rejects(
    new CrawlFoundryGlossaryProvider().post('', '', [post], integration),
    /CMS SEO settings/,
  );
  assert.equal(noIndexCalls.filter((call) => call.method === 'PATCH').length, 0);
});

test('rejects an invalid term id without contacting Directus', async () => {
  const calls = mockFetch();
  await assert.rejects(
    new CrawlFoundryGlossaryProvider().post(
      '',
      '',
      [{ id: 'post-1', settings: { termId: 'bad-id', termTitle: 'Bad' } }],
      integration,
    ),
    /valid glossary term/,
  );
  assert.equal(calls.length, 0);
});

process.on('exit', () => {
  AuthService.fixedDecryption = originalDecrypt;
});

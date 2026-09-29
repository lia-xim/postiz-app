const assert = require('node:assert/strict');
const { beforeEach, afterEach, test } = require('node:test');
const {
  Blog2SocialGmbProvider,
} = require('../apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/blog2social-gmb.provider.js');

const originalFetch = global.fetch;
const originalService = process.env.BLOG2SOCIAL_SERVICE_TOKEN;
const originalAccess = process.env.BLOG2SOCIAL_ACCESS_TOKEN;
const originalAllowedOrg = process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID;
const originalAllowedId = process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID;
beforeEach(() => {
  process.env.BLOG2SOCIAL_SERVICE_TOKEN = 'test-service-token';
  process.env.BLOG2SOCIAL_ACCESS_TOKEN = 'test-access-token';
  process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID = 'org-1';
  process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID = '456';
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalService === undefined) delete process.env.BLOG2SOCIAL_SERVICE_TOKEN;
  else process.env.BLOG2SOCIAL_SERVICE_TOKEN = originalService;
  if (originalAccess === undefined) delete process.env.BLOG2SOCIAL_ACCESS_TOKEN;
  else process.env.BLOG2SOCIAL_ACCESS_TOKEN = originalAccess;
  if (originalAllowedOrg === undefined) delete process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID;
  else process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID = originalAllowedOrg;
  if (originalAllowedId === undefined) delete process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID;
  else process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID = originalAllowedId;
});

const response = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const location = { client_user_network_id: 456, network_id: 18, name: 'GoogleBusinessProfile', display_name: 'Crawl Foundry' };

test('only connects a verified Blog2Social Google Business Profile location', async () => {
  global.fetch = async () => response([location]);
  const provider = new Blog2SocialGmbProvider();
  const result = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '456' })).toString('base64'),
    codeVerifier: '',
    organizationId: 'org-1',
  });
  assert.equal(result.id, '456');
  assert.equal(result.name, 'Crawl Foundry');
  assert.equal(result.accessToken, 'blog2social-server-managed');
  global.fetch = async () => response([{ ...location, name: 'Medium' }]);
  const wrongNetwork = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '456' })).toString('base64'),
    codeVerifier: '',
    organizationId: 'org-1',
  });
  assert.match(wrongNetwork, /Cannot verify/);
  global.fetch = async () => response([{ ...location, network_id: 99 }]);
  const wrongNetworkId = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '456' })).toString('base64'),
    codeVerifier: '',
    organizationId: 'org-1',
  });
  assert.match(wrongNetworkId, /Cannot verify/);
});

test('publishes one update with one image and requires a public result', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/user/auth/list')
      ? response([location])
      : response([{ error: 0, publish_url: 'https://www.google.com/search?example-post', network_post_id: 'gbp-1' }]);
  };
  const result = await new Blog2SocialGmbProvider().post('456', '', [{
    id: 'post-1', message: 'Useful local update',
    media: [{ type: 'image', path: 'https://crawlfoundry.com/update.jpg' }],
    settings: { url: 'https://crawlfoundry.com/blog/test' },
  }], { organizationId: 'org-1' });
  assert.equal(result[0].status, 'completed');
  assert.equal(result[0].releaseURL, 'https://www.google.com/search?example-post');
  assert.deepEqual(calls[1].body.b2s_posts, [{
    client_user_network_id: 456,
    message: 'Useful local update',
    postFormat: 1,
    customUrl: 'https://crawlfoundry.com/blog/test',
    mediaObjects: [{ type: 'IMAGE', url: 'https://crawlfoundry.com/update.jpg' }],
  }]);
});

test('rejects unsupported media and oversized text before a billable API call', async () => {
  const provider = new Blog2SocialGmbProvider();
  assert.match(await provider.checkValidity([[{ path: 'https://example.com/video.mp4' }]]), /PNG or JPEG/);
  assert.equal(await provider.checkValidity([[{ path: 'https://cms.crawlfoundry.com/assets/da99052f-a448-4434-a9f8-79952698e224?format=jpg' }]]), true);
  assert.match(await provider.checkValidity([[{ path: 'https://example.com/a.jpg' }, { path: 'https://example.com/b.jpg' }]]), /only one image/);
  global.fetch = async () => { throw new Error('API must not be called'); };
  await assert.rejects(provider.post('456', '', [{
    id: 'post-1', message: 'Update', settings: {},
    media: [{ type: 'video', path: 'https://example.com/video.mp4' }],
  }], { organizationId: 'org-1' }), /no video/);
  await assert.rejects(provider.post('456', '', [{
    id: 'post-1', message: 'Update', settings: {},
    media: [{ type: 'image', path: 'https://example.com/file.pdf' }],
  }], { organizationId: 'org-1' }), /PNG or JPEG/);
  await assert.rejects(provider.post('456', '', [{
    id: 'post-1', message: 'x'.repeat(1501), settings: {},
  }], { organizationId: 'org-1' }), /1500/);
});

test('arms once before publishing and never retries an uncertain result', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(String(url));
    return String(url).endsWith('/user/auth/list')
      ? response([location])
      : response([{ error: 0, publish_url: 'https://www.google.com/search?example-post' }]);
  };
  const provider = new Blog2SocialGmbProvider();
  const [pending] = await provider.postPending('456', '', [{ id: 'post-1', message: 'Update', settings: {} }], { organizationId: 'org-1' });
  assert.equal(pending.status, 'pending');
  assert.equal(calls.filter((url) => url.endsWith('/network/post/create')).length, 0);
  const ready = await provider.checkPostStatus('', pending.pendingData, {});
  await assert.rejects(provider.checkPostStatus('', ready.pendingData, {}), /outcome is unknown/);
  const completed = await provider.finalizePost('', ready.pendingData, { organizationId: 'org-1' });
  assert.equal(completed.status, 'completed');
  assert.equal(calls.filter((url) => url.endsWith('/network/post/create')).length, 1);
});

test('refuses other organizations and connection IDs before using shared credentials', async () => {
  global.fetch = async () => { throw new Error('API must not be called'); };
  const provider = new Blog2SocialGmbProvider();
  const auth = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '456' })).toString('base64'),
    codeVerifier: '', organizationId: 'org-2',
  });
  assert.match(auth, /Cannot verify/);
  await assert.rejects(provider.post('456', '', [
    { id: 'post-1', message: 'Update', settings: {} },
  ], { organizationId: 'org-2' }), /not enabled/);
  await assert.rejects(provider.post('789', '', [
    { id: 'post-1', message: 'Update', settings: {} },
  ], { organizationId: 'org-1' }), /not enabled/);
});

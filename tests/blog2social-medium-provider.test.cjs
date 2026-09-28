const assert = require('node:assert/strict');
const { beforeEach, afterEach, test } = require('node:test');
const {
  Blog2SocialMediumProvider,
} = require('../apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/blog2social-medium.provider.js');

const originalFetch = global.fetch;
const originalService = process.env.BLOG2SOCIAL_SERVICE_TOKEN;
const originalAccess = process.env.BLOG2SOCIAL_ACCESS_TOKEN;
beforeEach(() => {
  process.env.BLOG2SOCIAL_SERVICE_TOKEN = 'test-service-token';
  process.env.BLOG2SOCIAL_ACCESS_TOKEN = 'test-access-token';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalService === undefined) delete process.env.BLOG2SOCIAL_SERVICE_TOKEN;
  else process.env.BLOG2SOCIAL_SERVICE_TOKEN = originalService;
  if (originalAccess === undefined) delete process.env.BLOG2SOCIAL_ACCESS_TOKEN;
  else process.env.BLOG2SOCIAL_ACCESS_TOKEN = originalAccess;
});

const response = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

test('verifies the vendor connection before adding a Postiz channel', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return response([{ client_user_network_id: 123, network_id: 9, name: 'Medium', display_name: 'Crawl Foundry' }]);
  };
  const provider = new Blog2SocialMediumProvider();
  const result = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '123' })).toString('base64'),
    codeVerifier: '',
  });
  assert.equal(result.id, '123');
  assert.equal(result.accessToken, 'blog2social-server-managed');
  assert.equal(calls[0].url, 'https://api.blog2social.com/rest/v1.0/user/auth/list');
  assert.equal(calls[0].body.service_token, 'test-service-token');
  assert.equal(calls[0].body.access_token, 'test-access-token');
});

test('rejects an account ID from a different network', async () => {
  global.fetch = async () => response([
    { client_user_network_id: 123, network_id: 7, name: 'Reddit', display_name: 'Wrong account' },
  ]);
  const result = await new Blog2SocialMediumProvider().authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '123' })).toString('base64'),
    codeVerifier: '',
  });
  assert.match(result, /Cannot verify/);
});

test('publishes one article and requires a confirmed public URL', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith('/user/auth/list')) {
      return response([{ client_user_network_id: 123, network_id: 9, name: 'Medium', display_name: 'Crawl Foundry' }]);
    }
    return response([{ error: 0, publish_url: 'https://medium.com/@crawlfoundry/test', network_post_id: 'published-1' }]);
  };
  const result = await new Blog2SocialMediumProvider().post('123', '', [
    { id: 'post-1', message: 'Full article body', settings: { title: 'Useful title' } },
  ], {});
  assert.deepEqual(result, [{
    id: 'post-1', postId: 'published-1',
    releaseURL: 'https://medium.com/@crawlfoundry/test', status: 'completed',
  }]);
  assert.deepEqual(calls[1].body.b2s_posts, [{
    client_user_network_id: 123,
    title: 'Useful title',
    message: 'Full article body',
    postFormat: 0,
  }]);
});

test('does not report a partial API success as published', async () => {
  global.fetch = async (url) => String(url).endsWith('/user/auth/list')
    ? response([{ client_user_network_id: 123, network_id: 9, name: 'Medium', display_name: 'Crawl Foundry' }])
    : response([{ error: 1, b2s_error_code: 'CONTENT' }]);
  await assert.rejects(
    new Blog2SocialMediumProvider().post('123', '', [
      { id: 'post-1', message: 'Body', settings: { title: 'Title' } },
    ], {}),
    (error) => error.nonRetryable && /CONTENT/.test(error.message)
  );
});

test('arms the publish in durable workflow state before any billable call', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/user/auth/list')
      ? response([{ client_user_network_id: 123, network_id: 9, name: 'Medium', display_name: 'Crawl Foundry' }])
      : response([{ error: 0, publish_url: 'https://medium.com/@crawlfoundry/test' }]);
  };
  const provider = new Blog2SocialMediumProvider();
  const [pending] = await provider.postPending('123', '', [
    { id: 'post-1', message: 'Article', settings: { title: 'Title' } },
  ]);
  assert.equal(pending.status, 'pending');
  assert.equal(calls.filter((call) => call.url.endsWith('/network/post/create')).length, 0);
  const ready = await provider.checkPostStatus('', pending.pendingData, {});
  assert.equal(ready.status, 'ready');
  await assert.rejects(provider.checkPostStatus('', ready.pendingData, {}), /outcome is unknown/);
  const done = await provider.finalizePost('', ready.pendingData, {});
  assert.equal(done.status, 'completed');
  assert.equal(calls.filter((call) => call.url.endsWith('/network/post/create')).length, 1);
});

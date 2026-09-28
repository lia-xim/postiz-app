const assert = require('node:assert/strict');
const { beforeEach, afterEach, test } = require('node:test');
const {
  Blog2SocialRedditProvider,
} = require('../apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/blog2social-reddit.provider.js');
const {
  AuthService,
} = require('../apps/backend/dist/libraries/helpers/src/auth/auth.service.js');

const originalFetch = global.fetch;
const originalDecrypt = AuthService.fixedDecryption;
const originalEnv = Object.fromEntries([
  'BLOG2SOCIAL_SERVICE_TOKEN', 'BLOG2SOCIAL_ACCESS_TOKEN',
  'BLOG2SOCIAL_REDDIT_ALLOWED_SUBREDDITS',
].map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.BLOG2SOCIAL_SERVICE_TOKEN = 'test-service-token';
  process.env.BLOG2SOCIAL_ACCESS_TOKEN = 'test-access-token';
  process.env.BLOG2SOCIAL_REDDIT_ALLOWED_SUBREDDITS = 'SEOToolTalk,CrawlFoundry';
  AuthService.fixedDecryption = () => JSON.stringify({
    connectionId: '123', subreddit: 'r/SEOToolTalk',
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  AuthService.fixedDecryption = originalDecrypt;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const response = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const account = [{
  client_user_network_id: 123,
  network_id: 7,
  name: 'Reddit',
  display_name: 'r/SEOToolTalk',
}];
const post = {
  id: 'post-1',
  message: 'Useful discussion context',
  settings: { title: 'How do you audit SEO tools?', url: 'https://crawlfoundry.com/blog/example' },
};

test('connects only a Blog2Social authorization bound to the selected subreddit', async () => {
  global.fetch = async () => response(account);
  const provider = new Blog2SocialRedditProvider();
  const accepted = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '123', subreddit: 'r/SEOToolTalk' })).toString('base64'),
    codeVerifier: '',
  });
  assert.equal(accepted.id, '123');
  assert.equal(accepted.username, 'r/SEOToolTalk');
  const rejected = await provider.authenticate({
    code: Buffer.from(JSON.stringify({ connectionId: '123', subreddit: 'r/CrawlFoundry' })).toString('base64'),
    codeVerifier: '',
  });
  assert.match(rejected, /Cannot verify/);
});

test('publishes one link post and checks the returned Reddit community', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/user/auth/list')
      ? response(account)
      : response([{ error: 0, publish_url: 'https://www.reddit.com/r/SEOToolTalk/comments/abc/example/', network_post_id: 'abc' }]);
  };
  const published = await new Blog2SocialRedditProvider().post('123', '', [post], { customInstanceDetails: 'encrypted' });
  assert.equal(published[0].releaseURL, 'https://www.reddit.com/r/SEOToolTalk/comments/abc/example/');
  assert.deepEqual(calls[1].body.b2s_posts, [{
    client_user_network_id: 123,
    title: post.settings.title,
    message: post.message,
    postFormat: 0,
    customUrl: post.settings.url,
  }]);
});

test('never sends a post when the community is not on the server allowlist', async () => {
  process.env.BLOG2SOCIAL_REDDIT_ALLOWED_SUBREDDITS = '';
  let requests = 0;
  global.fetch = async () => { requests++; return response(account); };
  await assert.rejects(
    new Blog2SocialRedditProvider().post('123', '', [post], { customInstanceDetails: 'encrypted' }),
    /not approved/
  );
  assert.equal(requests, 0);
});

test('does not report a wrong-subreddit response as completed', async () => {
  global.fetch = async (url) => String(url).endsWith('/user/auth/list')
    ? response(account)
    : response([{ error: 0, publish_url: 'https://www.reddit.com/r/CrawlFoundry/comments/abc/example/' }]);
  await assert.rejects(
    new Blog2SocialRedditProvider().post('123', '', [post], { customInstanceDetails: 'encrypted' }),
    (error) => error.nonRetryable && /outside the selected subreddit/.test(error.message)
  );
});

test('arms a Reddit post before the billable API call and blocks replay', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/user/auth/list')
      ? response(account)
      : response([{ error: 0, publish_url: 'https://www.reddit.com/r/SEOToolTalk/comments/abc/example/' }]);
  };
  const provider = new Blog2SocialRedditProvider();
  const [pending] = await provider.postPending('123', '', [post], { customInstanceDetails: 'encrypted' });
  assert.equal(pending.status, 'pending');
  assert.equal(calls.filter((call) => call.url.endsWith('/network/post/create')).length, 0);
  const ready = await provider.checkPostStatus('', pending.pendingData, {});
  assert.equal(ready.status, 'ready');
  await assert.rejects(provider.checkPostStatus('', ready.pendingData, {}), /outcome is unknown/);
  const done = await provider.finalizePost('', ready.pendingData, { customInstanceDetails: 'encrypted' });
  assert.equal(done.status, 'completed');
  assert.equal(calls.filter((call) => call.url.endsWith('/network/post/create')).length, 1);
});

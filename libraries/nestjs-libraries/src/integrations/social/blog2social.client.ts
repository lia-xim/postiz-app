const API_ORIGIN = 'https://api.blog2social.com';
const API_PREFIX = '/rest/v1.0';

type Connection = {
  client_user_network_id: number;
  network_id: number;
  name: string;
  display_name: string;
};

export type PublishResult = {
  error: number;
  b2s_error_code?: string;
  publish_url?: string;
  network_post_id?: string;
  post_id?: number;
  extra?: { expired?: number };
};

export class Blog2SocialRejectedError extends Error {}

function credentials() {
  const serviceToken = process.env.BLOG2SOCIAL_SERVICE_TOKEN?.trim();
  const accessToken = process.env.BLOG2SOCIAL_ACCESS_TOKEN?.trim();
  if (!serviceToken || !accessToken) {
    throw new Error('Blog2Social API credentials are not configured');
  }
  return { service_token: serviceToken, access_token: accessToken };
}

export async function blog2SocialRequest(
  path: '/user/auth/list' | '/network/categories' | '/network/post/create',
  parameters: Record<string, unknown> = {}
): Promise<unknown> {
  const response = await fetch(`${API_ORIGIN}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...parameters, ...credentials() }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  // Never include the vendor response body in exceptions: it may echo tokens.
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Blog2SocialRejectedError(`Blog2Social API rejected the request (${response.status})`);
    }
    throw new Error(`Blog2Social API request failed (${response.status})`);
  }
  return response.json();
}

export async function connectedAccount(
  network: 'Medium' | 'Reddit',
  rawId: string
): Promise<Connection> {
  if (!/^[1-9][0-9]{0,14}$/.test(rawId)) {
    throw new Error('Enter a valid Blog2Social account connection ID');
  }
  const listed = await blog2SocialRequest('/user/auth/list');
  if (!Array.isArray(listed)) {
    throw new Error('Blog2Social did not return a connection list');
  }
  const found = listed.find((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Record<string, unknown>;
    return (
      value.client_user_network_id === Number(rawId) &&
      value.name === network &&
      typeof value.network_id === 'number' &&
      typeof value.display_name === 'string'
    );
  }) as Connection | undefined;
  if (!found) {
    throw new Error(`No connected Blog2Social ${network} account matches this ID`);
  }
  return found;
}

export function requirePublishedResult(raw: unknown): PublishResult & {
  publish_url: string;
} {
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error('Blog2Social returned an unexpected publication result');
  }
  const result = raw[0] as PublishResult;
  if (result?.error !== 0) {
    const code = /^[A-Z_]{2,40}$/.test(result?.b2s_error_code || '')
      ? result.b2s_error_code
      : 'UNKNOWN';
    throw new Blog2SocialRejectedError(`Blog2Social rejected the publication (${code})`);
  }
  if (!result.publish_url || !/^https:\/\//.test(result.publish_url)) {
    // This may already have been published. Do not automatically retry it.
    throw new Error('Blog2Social accepted the post but returned no public URL; check the account before retrying');
  }
  return result as PublishResult & { publish_url: string };
}

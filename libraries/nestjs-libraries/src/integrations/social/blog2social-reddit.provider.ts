import { Integration } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { Blog2SocialRedditDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-reddit.dto';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { BadBody, SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  blog2SocialRequest,
  Blog2SocialRejectedError,
  connectedAccount,
  requirePublishedResult,
} from './blog2social.client';

function community(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Select a Reddit community');
  const value = raw.trim().replace(/^r\//i, '');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(value)) {
    throw new Error('Select a valid Reddit community');
  }
  return value;
}

function connectedCommunity(displayName: string, expected: string): boolean {
  // Blog2Social connects a Reddit subreddit as its own authorization. Do not
  // accept a generic Reddit account whose publishing destination is ambiguous.
  return new RegExp(`(?:^|\\s)(?:r/)?${expected}(?:$|\\s)`, 'i').test(displayName);
}

function allowedCommunity(subreddit: string): boolean {
  return (process.env.BLOG2SOCIAL_REDDIT_ALLOWED_SUBREDDITS || '')
    .split(',')
    .map((part) => part.trim().replace(/^r\//i, '').toLowerCase())
    .includes(subreddit.toLowerCase());
}

export class Blog2SocialRedditProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'blog2social-reddit';
  name = 'Reddit (Blog2Social)';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = Blog2SocialRedditDto;
  override maxConcurrentJob = 1;

  maxLength() { return 10000; }

  async customFields() {
    return [
      {
        key: 'connectionId',
        label: 'Blog2Social Reddit connection ID',
        hint: 'Connect this subreddit in Blog2Social first, then use its client_user_network_id.',
        validation: '/^[1-9][0-9]{0,14}$/',
        type: 'text' as const,
      },
      {
        key: 'subreddit',
        label: 'Connected subreddit',
        hint: 'The subreddit selected during Blog2Social authorization, such as r/SEOToolTalk.',
        validation: '/^(?:r\\/)?[A-Za-z0-9_]{2,21}$/',
        type: 'text' as const,
      },
    ];
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return { url: state, codeVerifier: makeSecureId(10), state };
  }

  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> {
    return { id: '', name: '', accessToken: '', refreshToken: '', expiresIn: 0, username: '' };
  }

  async authenticate(params: { code: string; codeVerifier: string }) {
    try {
      const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
      const subreddit = community(body.subreddit);
      const connection = await connectedAccount('Reddit', body.connectionId);
      if (!connectedCommunity(connection.display_name, subreddit)) {
        throw new Error('Blog2Social connection does not identify the selected subreddit');
      }
      return {
        id: String(connection.client_user_network_id),
        name: `r/${subreddit}`,
        username: `r/${subreddit}`,
        picture: `${process.env.FRONTEND_URL}/icons/platforms/reddit.png`,
        accessToken: 'blog2social-server-managed',
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot verify this subreddit connection in Blog2Social';
    }
  }

  async post(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialRedditDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    const title = post?.settings?.title?.trim();
    const message = post?.message?.trim();
    const rawUrl = post?.settings?.url;
    let url: URL | null = null;
    try { url = rawUrl ? new URL(rawUrl) : null; } catch { /* invalid URL */ }
    if (!title || !message || !url || url.protocol !== 'https:' || url.username || url.password) {
      throw ApplicationFailure.nonRetryable('A Reddit title, message and HTTPS link are required');
    }
    let stored: { connectionId: string; subreddit: string };
    try {
      stored = JSON.parse(AuthService.fixedDecryption(integration.customInstanceDetails!));
    } catch {
      throw ApplicationFailure.nonRetryable('Reddit connection details are unavailable');
    }
    let subreddit: string;
    try { subreddit = community(stored.subreddit); }
    catch { throw ApplicationFailure.nonRetryable('Reddit community setting is invalid'); }
    if (stored.connectionId !== id || !allowedCommunity(subreddit)) {
      throw ApplicationFailure.nonRetryable('Reddit community is not approved for publishing');
    }
    const connection = await connectedAccount('Reddit', id);
    if (!connectedCommunity(connection.display_name, subreddit)) {
      throw ApplicationFailure.nonRetryable('Reddit connection no longer identifies the selected community');
    }
    try {
      const raw = await blog2SocialRequest('/network/post/create', {
        client_user_network_id: connection.client_user_network_id,
        b2s_posts: [{
          client_user_network_id: connection.client_user_network_id,
          title,
          message,
          postFormat: 0,
          customUrl: url.href,
        }],
      });
      const result = requirePublishedResult(raw);
      const published = new URL(result.publish_url);
      if (!['reddit.com', 'www.reddit.com'].includes(published.hostname) ||
          !published.pathname.toLowerCase().startsWith(`/r/${subreddit.toLowerCase()}/`)) {
        throw new Error('Blog2Social returned a post outside the selected subreddit; check the account before retrying');
      }
      return [{
        id: post.id,
        postId: String(result.network_post_id || ''),
        releaseURL: result.publish_url,
        status: 'completed',
      }];
    } catch (error) {
      if (error instanceof Blog2SocialRejectedError) {
        throw new BadBody(this.identifier, '{}', Buffer.from('{}'), error.message);
      }
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : 'Blog2Social publication outcome is unknown'
      );
    }
  }

  async postPending(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialRedditDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    let url: URL | null = null;
    try { url = post?.settings?.url ? new URL(post.settings.url) : null; } catch { /* invalid URL */ }
    if (!post?.settings?.title?.trim() || !post?.message?.trim() ||
        !url || url.protocol !== 'https:' || url.username || url.password) {
      throw ApplicationFailure.nonRetryable('A Reddit title, message and HTTPS link are required');
    }
    let stored: { connectionId: string; subreddit: string };
    try { stored = JSON.parse(AuthService.fixedDecryption(integration.customInstanceDetails!)); }
    catch { throw ApplicationFailure.nonRetryable('Reddit connection details are unavailable'); }
    let subreddit: string;
    try { subreddit = community(stored.subreddit); }
    catch { throw ApplicationFailure.nonRetryable('Reddit community setting is invalid'); }
    if (stored.connectionId !== id || !allowedCommunity(subreddit)) {
      throw ApplicationFailure.nonRetryable('Reddit community is not approved for publishing');
    }
    const connection = await connectedAccount('Reddit', id);
    if (!connectedCommunity(connection.display_name, subreddit)) {
      throw ApplicationFailure.nonRetryable('Reddit connection no longer identifies the selected community');
    }
    return [{
      id: post.id,
      postId: '',
      releaseURL: '',
      status: 'pending',
      pendingData: {
        accountId: id,
        postId: post.id,
        title: post.settings.title,
        message: post.message,
        url: post.settings.url,
        armed: false,
      },
    }];
  }

  override async checkPostStatus(
    _accessToken: string,
    pendingData: { armed: boolean; accountId: string; postId: string; title: string; message: string; url: string },
    _integration: Integration
  ): Promise<PendingCheckResponse> {
    if (pendingData.armed) {
      throw new Error('Reddit publication outcome is unknown; check Blog2Social before retrying');
    }
    return { status: 'ready', pendingData: { ...pendingData, armed: true } };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: { armed: boolean; accountId: string; postId: string; title: string; message: string; url: string },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    if (!pendingData.armed) throw new Error('Reddit publication was not armed');
    const [result] = await this.post(pendingData.accountId, accessToken, [{
      id: pendingData.postId,
      message: pendingData.message,
      settings: { title: pendingData.title, url: pendingData.url },
    }], integration);
    return { status: 'completed', postId: result.postId, releaseURL: result.releaseURL };
  }
}

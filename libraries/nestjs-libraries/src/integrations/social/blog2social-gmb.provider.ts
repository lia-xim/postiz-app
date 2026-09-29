import { Integration } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { BadBody, SocialAbstract, ValidityMedia } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Blog2SocialGmbDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-gmb.dto';
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

type PendingPost = {
  armed: boolean;
  accountId: string;
  postId: string;
  message: string;
  imageUrl?: string;
  url?: string;
};

function supportedImagePath(pathname: string) {
  const lastSegment = pathname.split('/').pop() || '';
  const extension = /\.([a-z0-9]+)$/i.exec(lastSegment)?.[1];
  return !extension || /^(?:png|jpe?g)$/i.test(extension);
}

function allowed(id: string, organizationId: string | undefined) {
  if (!process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID ||
      !process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID ||
      organizationId !== process.env.BLOG2SOCIAL_GMB_ALLOWED_ORGANIZATION_ID ||
      id !== process.env.BLOG2SOCIAL_GMB_ALLOWED_CONNECTION_ID) {
    throw ApplicationFailure.nonRetryable('This Google Business Profile connection is not enabled for this organization');
  }
}

function content(post: PostDetails<Blog2SocialGmbDto> | undefined) {
  const message = post?.message?.trim();
  if (!message || Array.from(message).length > 1500) {
    throw ApplicationFailure.nonRetryable('A Google Business Profile update of at most 1500 characters is required');
  }
  if ((post?.media?.length || 0) > 1 || post?.media?.some((item) => item.type !== 'image')) {
    throw ApplicationFailure.nonRetryable('Google Business Profile accepts at most one image and no video');
  }
  const rawImageUrl = post?.media?.[0]?.path;
  const rawUrl = post?.settings?.url?.trim();
  let url: URL | undefined;
  if (rawUrl) {
    try { url = new URL(rawUrl); }
    catch { throw ApplicationFailure.nonRetryable('The destination link needs an HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw ApplicationFailure.nonRetryable('The destination link needs an HTTPS URL');
    }
  }
  if (!rawImageUrl) return { message, url: url?.href };
  let imageUrl: URL;
  try { imageUrl = new URL(rawImageUrl); }
  catch { throw ApplicationFailure.nonRetryable('The image needs a public HTTPS URL'); }
  if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) {
    throw ApplicationFailure.nonRetryable('The image needs a public HTTPS URL');
  }
  if (!supportedImagePath(imageUrl.pathname)) {
    throw ApplicationFailure.nonRetryable('Google Business Profile accepts only PNG or JPEG images');
  }
  return { message, imageUrl: imageUrl.href, url: url?.href };
}

export class Blog2SocialGmbProvider extends SocialAbstract implements SocialProvider {
  identifier = 'blog2social-gmb';
  name = 'Google Business Profile (Blog2Social)';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = Blog2SocialGmbDto;
  override maxConcurrentJob = 1;

  maxLength() { return 1500; }

  override async checkValidity(items: Array<ValidityMedia[]>): Promise<string | true> {
    if ((items?.[0]?.length || 0) > 1) {
      return 'Google Business Profile accepts only one image';
    }
    const path = items?.[0]?.[0]?.path;
    if (path) {
      let url: URL;
      try { url = new URL(path); }
      catch { return 'The image needs a public HTTPS URL'; }
      if (url.protocol !== 'https:' || url.username || url.password) {
        return 'The image needs a public HTTPS URL';
      }
      if (!supportedImagePath(url.pathname)) {
        return 'Google Business Profile accepts only PNG or JPEG images';
      }
    }
    return true;
  }

  async customFields() {
    return [{
      key: 'connectionId',
      label: 'Blog2Social Google Business Profile connection ID',
      hint: 'Connect the location in Blog2Social first, then use its client_user_network_id.',
      validation: '/^[1-9][0-9]{0,14}$/',
      type: 'text' as const,
    }];
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return { url: state, codeVerifier: makeSecureId(10), state };
  }

  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> {
    return { id: '', name: '', accessToken: '', refreshToken: '', expiresIn: 0, username: '' };
  }

  async authenticate(params: { code: string; codeVerifier: string; organizationId?: string }) {
    try {
      const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
      allowed(body.connectionId, params.organizationId);
      const connection = await connectedAccount('Google Business Profile', body.connectionId);
      return {
        id: String(connection.client_user_network_id),
        name: connection.display_name,
        username: connection.display_name,
        picture: `${process.env.FRONTEND_URL}/icons/platforms/gmb.png`,
        accessToken: 'blog2social-server-managed',
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot verify this Google Business Profile connection in Blog2Social';
    }
  }

  async post(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialGmbDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    allowed(id, integration.organizationId);
    const { message, imageUrl, url } = content(post);
    const connection = await connectedAccount('Google Business Profile', id);
    try {
      const raw = await blog2SocialRequest('/network/post/create', {
        client_user_network_id: connection.client_user_network_id,
        b2s_posts: [{
          client_user_network_id: connection.client_user_network_id,
          message,
          postFormat: imageUrl ? 1 : 0,
          ...(url ? { customUrl: url } : {}),
          ...(imageUrl ? { mediaObjects: [{ type: 'IMAGE', url: imageUrl }] } : {}),
        }],
      });
      const result = requirePublishedResult(raw);
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
      // The vendor has no documented idempotency key. An uncertain response
      // must not trigger another billable create request.
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : 'Google Business Profile publication outcome is unknown'
      );
    }
  }

  async postPending(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialGmbDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    allowed(id, integration.organizationId);
    const { message, imageUrl, url } = content(post);
    await connectedAccount('Google Business Profile', id);
    return [{
      id: post.id,
      postId: '',
      releaseURL: '',
      status: 'pending',
      pendingData: { accountId: id, postId: post.id, message, imageUrl, url, armed: false },
    }];
  }

  override async checkPostStatus(
    _accessToken: string,
    pendingData: PendingPost,
    _integration: Integration
  ): Promise<PendingCheckResponse> {
    if (pendingData.armed) {
      throw new Error('Google Business Profile publication outcome is unknown; check Blog2Social before retrying');
    }
    return { status: 'ready', pendingData: { ...pendingData, armed: true } };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: PendingPost,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    if (!pendingData.armed) throw new Error('Google Business Profile publication was not armed');
    const [result] = await this.post(pendingData.accountId, accessToken, [{
      id: pendingData.postId,
      message: pendingData.message,
      settings: { url: pendingData.url },
      ...(pendingData.imageUrl ? { media: [{ type: 'image', path: pendingData.imageUrl }] } : {}),
    }], integration);
    return { status: 'completed', postId: result.postId, releaseURL: result.releaseURL };
  }
}

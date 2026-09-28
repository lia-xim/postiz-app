import { Integration } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';
import { Blog2SocialMediumDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-medium.dto';
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

export class Blog2SocialMediumProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'blog2social-medium';
  name = 'Medium (Blog2Social)';
  isBetweenSteps = false;
  scopes: string[] = [];
  // Blog2Social reports HTML support for Medium, so keep article formatting.
  editor = 'html' as const;
  dto = Blog2SocialMediumDto;
  override maxConcurrentJob = 1;

  maxLength() { return 100000; }

  async customFields() {
    return [{
      key: 'connectionId',
      label: 'Blog2Social Medium connection ID',
      hint: 'Connect Medium in Blog2Social first, then use its client_user_network_id.',
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

  async authenticate(params: { code: string; codeVerifier: string }) {
    try {
      const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
      const connection = await connectedAccount('Medium', body.connectionId);
      return {
        id: String(connection.client_user_network_id),
        name: connection.display_name,
        username: connection.display_name,
        picture: `${process.env.FRONTEND_URL}/icons/platforms/medium.png`,
        // App credentials stay in the server environment, not the Postiz DB.
        accessToken: 'blog2social-server-managed',
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot verify this Medium connection in Blog2Social';
    }
  }

  async post(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialMediumDto>[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    const title = post?.settings?.title?.trim();
    const message = post?.message?.trim();
    if (!title || !message) {
      throw ApplicationFailure.nonRetryable('A Medium title and article body are required');
    }
    const connection = await connectedAccount('Medium', id);
    try {
      const raw = await blog2SocialRequest('/network/post/create', {
        client_user_network_id: connection.client_user_network_id,
        b2s_posts: [{
          client_user_network_id: connection.client_user_network_id,
          title,
          message,
          postFormat: 0,
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
      // A timeout, HTTP error or malformed result may follow a successful
      // publication. Temporal must not replay a billable create request.
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : 'Blog2Social publication outcome is unknown'
      );
    }
  }

  async postPending(
    id: string,
    _accessToken: string,
    postDetails: PostDetails<Blog2SocialMediumDto>[]
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    if (!post?.settings?.title?.trim() || !post?.message?.trim()) {
      throw ApplicationFailure.nonRetryable('A Medium title and article body are required');
    }
    await connectedAccount('Medium', id);
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
        armed: false,
      },
    }];
  }

  override async checkPostStatus(
    _accessToken: string,
    pendingData: { armed: boolean; accountId: string; postId: string; title: string; message: string },
    _integration: Integration
  ): Promise<PendingCheckResponse> {
    if (pendingData.armed) {
      // The publish call may have succeeded before its activity failed.
      // Blog2Social has no documented idempotency key or lookup by our post ID.
      throw new Error('Medium publication outcome is unknown; check Blog2Social before retrying');
    }
    return { status: 'ready', pendingData: { ...pendingData, armed: true } };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: { armed: boolean; accountId: string; postId: string; title: string; message: string },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    if (!pendingData.armed) throw new Error('Medium publication was not armed');
    const [result] = await this.post(pendingData.accountId, accessToken, [{
      id: pendingData.postId,
      message: pendingData.message,
      settings: { title: pendingData.title },
    }], integration);
    return { status: 'completed', postId: result.postId, releaseURL: result.releaseURL };
  }
}

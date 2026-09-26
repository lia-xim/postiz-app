import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { CrawlFoundryNativeDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/cf-native.dto';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { SocialAbstract } from '../social.abstract';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from './social.integrations.interface';

type NativeKind = 'newsletter' | 'announcement';
type Credentials = { token: string };

function endpoint(): string {
  const raw = process.env.CRAWL_FOUNDRY_CONVEX_SITE_URL;
  const parsed = raw ? new URL(raw) : null;
  if (
    !parsed || parsed.protocol !== 'https:' || parsed.username ||
    parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
  ) {
    throw new Error('Crawl Foundry dispatch endpoint is not configured');
  }
  return parsed.origin;
}

function credentials(raw: Credentials): Credentials {
  const configured = process.env.CRAWL_FOUNDRY_POSTIZ_DISPATCH_SECRET;
  if (!configured || configured.length < 32 || raw?.token !== configured) {
    throw new Error('Crawl Foundry dispatch credential is invalid');
  }
  return { token: configured };
}

async function request(
  auth: Credentials,
  kind: NativeKind,
  body?: { recordId: string; postId: string }
): Promise<void> {
  const response = await fetch(`${endpoint()}/postiz-dispatch`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify({ kind, ...body }) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Crawl Foundry ${kind} dispatch failed (${response.status})`);
  }
}

abstract class CrawlFoundryNativeProvider
  extends SocialAbstract
  implements SocialProvider
{
  abstract identifier: string;
  abstract name: string;
  abstract kind: NativeKind;
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = CrawlFoundryNativeDto;
  override maxConcurrentJob = 1;

  maxLength() { return 10000; }

  async customFields() {
    return [{
      key: 'token',
      label: 'Crawl Foundry dispatch token',
      validation: '/^.+$/',
      type: 'password' as const,
    }];
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return { url: state, codeVerifier: makeSecureId(10), state };
  }

  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> {
    return { id: '', name: '', accessToken: '', refreshToken: '', expiresIn: 0, username: '' };
  }

  async authenticate(params: { code: string; codeVerifier: string; refresh?: string }) {
    try {
      const auth = credentials(JSON.parse(Buffer.from(params.code, 'base64').toString()));
      await request(auth, this.kind);
      return {
        id: `crawl-foundry-${this.kind}`,
        name: this.name,
        username: 'crawlfoundry.com',
        picture: `${process.env.FRONTEND_URL}/icons/platforms/crawlfoundry-blog.png`,
        accessToken: auth.token,
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot connect to the Crawl Foundry dispatch endpoint';
    }
  }

  async post(
    _id: string,
    _accessToken: string,
    postDetails: PostDetails<CrawlFoundryNativeDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const recordId = postDetails[0]?.settings?.recordId;
    if (!recordId || !/^[a-zA-Z0-9_-]{1,200}$/.test(recordId)) {
      throw new Error('Choose a valid Crawl Foundry record');
    }
    const auth = credentials(JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    ));
    await request(auth, this.kind, { recordId, postId: postDetails[0].id });
    return [{
      id: postDetails[0].id,
      postId: recordId,
      // Dispatch was accepted. Newsletter delivery continues asynchronously;
      // neither channel has a single public post URL at this point.
      releaseURL: '',
      status: 'completed',
    }];
  }
}

export class CrawlFoundryNewsletterProvider extends CrawlFoundryNativeProvider {
  identifier = 'cfnewsletter';
  name = 'Crawl Foundry Newsletter';
  kind = 'newsletter' as const;
}

export class CrawlFoundryAnnouncementProvider extends CrawlFoundryNativeProvider {
  identifier = 'cfannouncement';
  name = 'Crawl Foundry Announcements';
  kind = 'announcement' as const;
}

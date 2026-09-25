import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { CrawlFoundryBlogDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/crawlfoundry-blog.dto';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { SocialAbstract } from '../social.abstract';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from './social.integrations.interface';

type DirectusCredentials = { url: string; token: string };
type Article = {
  id: string;
  title: string;
  slug: string;
  status: string;
  canonical_url?: string | null;
  language?: { code?: string } | string | null;
};

const ARTICLE_FIELDS = 'id,title,slug,status,canonical_url,language.code';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The configured URL is an exact allowlist for the internal Directus service. */
function credentials(raw: DirectusCredentials): DirectusCredentials {
  const allowed = process.env.CRAWL_FOUNDRY_DIRECTUS_URL?.replace(/\/+$/, '');
  const url = raw?.url?.trim().replace(/\/+$/, '');
  if (!allowed || url !== allowed || !raw?.token?.trim()) {
    throw new Error(
      'Directus URL or token is not configured for Crawl Foundry Blog'
    );
  }
  return { url, token: raw.token.trim() };
}

function storedCredentials(integration: Integration): DirectusCredentials {
  return credentials(
    JSON.parse(AuthService.fixedDecryption(integration.customInstanceDetails!))
  );
}

async function directus<T>(
  auth: DirectusCredentials,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  // Exact URL allowlisting and redirect rejection are required because the
  // Postiz SSRF-safe fetch helper intentionally blocks private Docker networks.
  const response = await fetch(`${auth.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Directus denied the publishing token (401/403)');
  }
  if (response.status === 404)
    throw new Error('Directus article was not found');
  if (!response.ok)
    throw new Error(`Directus request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function releaseUrl(article: Article): string {
  if (article.canonical_url) {
    const canonical = new URL(article.canonical_url);
    if (
      canonical.protocol !== 'https:' ||
      canonical.hostname !== 'crawlfoundry.com'
    ) {
      throw new Error('Article canonical URL is outside crawlfoundry.com');
    }
    return canonical.href;
  }
  if (!/^[a-z0-9-]+$/.test(article.slug))
    throw new Error('Article slug is invalid');
  const language =
    typeof article.language === 'string'
      ? article.language
      : article.language?.code;
  return `https://crawlfoundry.com/${language === 'de' ? 'de/' : ''}blog/${
    article.slug
  }`;
}

export class CrawlFoundryBlogProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'crawlfoundry-blog';
  name = 'Crawl Foundry Blog';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = CrawlFoundryBlogDto;
  override maxConcurrentJob = 1;

  maxLength() {
    return 10000;
  }

  async customFields() {
    return [
      {
        key: 'url',
        label: 'Directus URL',
        validation: '/^https?:\\/\\/.+$/',
        type: 'text' as const,
      },
      {
        key: 'token',
        label: 'Directus token',
        validation: '/^.+$/',
        type: 'password' as const,
      },
    ];
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return { url: state, codeVerifier: makeSecureId(10), state };
  }

  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> {
    return {
      id: '',
      name: '',
      accessToken: '',
      refreshToken: '',
      expiresIn: 0,
      username: '',
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    try {
      const auth = credentials(
        JSON.parse(Buffer.from(params.code, 'base64').toString())
      );
      await directus<{ data: { id: string } }>(auth, '/users/me?fields=id');
      return {
        id: 'crawl-foundry-blog',
        name: this.name,
        username: 'crawlfoundry.com',
        picture: `${process.env.FRONTEND_URL}/icons/platforms/crawlfoundry-blog.png`,
        accessToken: auth.token,
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot connect to Directus with these credentials';
    }
  }

  @Tool({
    description: 'Existing draft or scheduled blog translations',
    dataSchema: [],
  })
  async articles(
    _token: string,
    _data: unknown,
    _internalId: string,
    integration: Integration
  ) {
    const auth = storedCredentials(integration);
    const result: { id: string; name: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({
        fields: ARTICLE_FIELDS,
        'filter[status][_in]': 'draft,scheduled',
        sort: 'title',
        limit: '100',
        page: String(page),
      });
      const response = await directus<{ data: Article[] }>(
        auth,
        `/items/posts_translations?${query}`
      );
      for (const article of response.data) {
        const language =
          typeof article.language === 'string'
            ? article.language
            : article.language?.code;
        result.push({
          id: article.id,
          name: `${article.title} (${language || '?'})`,
        });
      }
      if (response.data.length < 100) return result;
    }
    throw new Error('Directus article list exceeds the supported page limit');
  }

  async post(
    _id: string,
    _accessToken: string,
    postDetails: PostDetails<CrawlFoundryBlogDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const detail = postDetails[0];
    const articleId = detail?.settings?.articleId;
    if (!articleId || !UUID.test(articleId))
      throw new Error('Choose a valid blog article');
    const auth = storedCredentials(integration);
    const path = `/items/posts_translations/${encodeURIComponent(
      articleId
    )}?fields=${ARTICLE_FIELDS}`;
    const read = async () =>
      (await directus<{ data: Article }>(auth, path)).data;
    let article = await read();
    if (article.status !== 'published') {
      if (article.status !== 'draft' && article.status !== 'scheduled') {
        throw new Error(
          'The selected blog article is no longer a draft or scheduled'
        );
      }
      await directus(
        auth,
        `/items/posts_translations/${encodeURIComponent(articleId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'scheduled',
            scheduled_for: new Date().toISOString(),
          }),
        }
      );
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        article = await read();
        if (article.status === 'published') break;
        if (article.status !== 'scheduled') {
          throw new Error(
            `Directus article left the publishing queue (${article.status})`
          );
        }
      }
      if (article.status !== 'published') {
        throw new Error(
          'Directus scheduler did not publish the article within three minutes'
        );
      }
    }
    return [
      {
        id: detail.id,
        postId: article.id,
        releaseURL: releaseUrl(article),
        status: 'completed',
      },
    ];
  }
}

import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { CrawlFoundryGlossaryDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/cfglossary.dto';
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
type Term = {
  id: string;
  status: string;
  discovery_released_at?: string | null;
  postiz_post_id?: string | null;
};
type Translation = {
  id: string;
  title: string;
  slug: string;
  status: string;
  no_index?: boolean | null;
  sitemap_included?: boolean | null;
  release_channel?: string | null;
  language?: { code?: string } | string | null;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSLATION_FIELDS =
  'id,title,slug,status,no_index,sitemap_included,release_channel,language.code,glossary_entry.id';
const WEB_REVALIDATION_URL =
  'https://crawlfoundry.com/api/directus/revalidate';

function credentials(raw: DirectusCredentials): DirectusCredentials {
  const allowed = process.env.CRAWL_FOUNDRY_DIRECTUS_URL?.replace(/\/+$/, '');
  const url = raw?.url?.trim().replace(/\/+$/, '');
  if (!allowed || url !== allowed || !raw?.token?.trim()) {
    throw new Error('Directus URL or token is not configured for Crawl Foundry Glossar');
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
  if (response.status === 404) throw new Error('Directus glossary term was not found');
  if (!response.ok) throw new Error(`Directus request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function language(translation: Translation): string | undefined {
  return typeof translation.language === 'string'
    ? translation.language
    : translation.language?.code;
}

function publicUrl(translation: Translation): string {
  if (!/^[a-z0-9-]+$/.test(translation.slug)) {
    throw new Error('Glossary slug is invalid');
  }
  const locale = language(translation);
  if (locale !== 'de' && locale !== 'en') {
    throw new Error('Glossary release requires a German or English translation');
  }
  return `https://crawlfoundry.com/${locale === 'de' ? 'de/' : ''}glossary/${translation.slug}`;
}

async function revalidateWebsite(translations: Translation[]): Promise<void> {
  const secret = process.env.CRAWL_FOUNDRY_REVALIDATION_SECRET;
  if (!secret) throw new Error('Website revalidation secret is not configured');
  const response = await fetch(WEB_REVALIDATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection: 'glossary_entries',
      slugs: translations.map((translation) => ({
        locale: language(translation),
        slug: translation.slug,
      })),
      secret,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Website glossary revalidation failed (${response.status})`);
  }
}

async function websiteReleased(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return false;
    if (response.headers.get('x-robots-tag')?.toLowerCase().includes('noindex')) {
      return false;
    }
    const html = await response.text();
    const robots = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i)?.[1];
    return robots != null && !robots.toLowerCase().includes('noindex');
  } catch {
    return false;
  }
}

export class CrawlFoundryGlossaryProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'cfglossary';
  name = 'Crawl Foundry Glossar';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = CrawlFoundryGlossaryDto;
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
        id: 'crawl-foundry-glossary',
        name: this.name,
        username: 'crawlfoundry.com',
        picture: `${process.env.FRONTEND_URL}/icons/platforms/cfglossary.png`,
        accessToken: auth.token,
        refreshToken: '',
        expiresIn: 100 * 365 * 24 * 60 * 60,
      };
    } catch {
      return 'Cannot connect to Directus with these credentials';
    }
  }

  @Tool({
    description: 'Published glossary terms awaiting search release',
    dataSchema: [],
  })
  async terms(
    _token: string,
    _data: unknown,
    _internalId: string,
    integration: Integration
  ) {
    const auth = storedCredentials(integration);
    const result: { id: string; name: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({
        fields: TRANSLATION_FIELDS,
        'filter[status][_eq]': 'published',
        'filter[language][code][_eq]': 'de',
        'filter[glossary_entry][status][_neq]': 'archived',
        'filter[glossary_entry][discovery_released_at][_null]': 'true',
        sort: 'title',
        limit: '100',
        page: String(page),
      });
      const response = await directus<{ data: (Translation & {
        glossary_entry?: { id?: string };
      })[] }>(auth, `/items/glossary_entries_translations?${query}`);
      for (const item of response.data) {
        if (item.glossary_entry?.id) {
          result.push({ id: item.glossary_entry.id, name: item.title });
        }
      }
      if (response.data.length < 100) return result;
    }
    throw new Error('Directus glossary list exceeds the supported page limit');
  }

  async post(
    _id: string,
    _accessToken: string,
    postDetails: PostDetails<CrawlFoundryGlossaryDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const detail = postDetails[0];
    const termId = detail?.settings?.termId;
    if (!termId || !UUID.test(termId)) {
      throw new Error('Choose a valid glossary term');
    }
    const auth = storedCredentials(integration);
    const term = (await directus<{ data: Term }>(
      auth,
      `/items/glossary_entries/${encodeURIComponent(termId)}?fields=id,status,discovery_released_at,postiz_post_id`
    )).data;
    if (term.status !== 'active') {
      throw new Error('The selected glossary term is not active');
    }
    if (term.postiz_post_id != null && term.postiz_post_id !== detail.id) {
      throw new Error('Glossary term is bound to a different Postiz post');
    }
    const query = new URLSearchParams({
      fields: TRANSLATION_FIELDS,
      'filter[glossary_entry][_eq]': termId,
      limit: '100',
    });
    const translations = (await directus<{ data: Translation[] }>(
      auth,
      `/items/glossary_entries_translations?${query}`
    )).data.filter((item) => item.status === 'published' &&
      item.release_channel === 'production');
    const german = translations.find((item) => language(item) === 'de');
    const english = translations.find((item) => language(item) === 'en');
    if (!german || !english) {
      throw new Error('Glossary release requires published German and English translations');
    }
    if ([german, english].some((item) =>
      item.no_index === true || item.sitemap_included === false
    )) {
      throw new Error('Glossary release is blocked by CMS SEO settings');
    }
    const url = publicUrl(german);
    const englishUrl = publicUrl(english);
    if (!term.discovery_released_at) {
      await directus(
        auth,
        `/items/glossary_entries/${encodeURIComponent(termId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            discovery_released_at: new Date().toISOString(),
          }),
        }
      );
    }
    // A retry after a failed revalidation is safe: the CMS receipt is retained.
    await revalidateWebsite(translations);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const [germanReleased, englishReleased] = await Promise.all([
        websiteReleased(url),
        websiteReleased(englishUrl),
      ]);
      if (germanReleased && englishReleased) {
        return [{
          id: detail.id,
          postId: termId,
          releaseURL: url,
          status: 'completed',
        }];
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error('Website did not release the glossary term within three minutes');
  }
}

import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { DevToSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/dev.to.settings.dto';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';

export class DevToProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Dev.to has moderate publishing limits
  identifier = 'devto';
  name = 'Dev.to';
  isBetweenSteps = false;
  editor = 'markdown' as const;
  scopes = [] as string[];
  maxLength() {
    return 100000;
  }
  dto = DevToSettingsDto;

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url: state,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  override handleErrors(body: string) {
    if (body.indexOf('Canonical url has already been taken') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Canonical URL already exists',
      };
    }

    return undefined;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
    try {
      const { name, id, profile_image, username } = await (
        await fetch('https://dev.to/api/users/me', {
          headers: {
            'api-key': body.apiKey,
          },
        })
      ).json();

      return {
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: body.apiKey,
        id,
        name,
        picture: profile_image || '',
        username,
      };
    } catch (err) {
      return 'Invalid credentials';
    }
  }

  @Tool({ description: 'Tag list', dataSchema: [] })
  async tags(token: string) {
    const tags = await (
      await fetch('https://dev.to/api/tags?per_page=1000&page=1', {
        headers: {
          'api-key': token,
        },
      })
    ).json();

    return tags.map((p: any) => ({ value: p.id, label: p.name }));
  }

  @Tool({ description: 'Organization list', dataSchema: [] })
  async organizations(token: string) {
    const read = async (path: string) => {
      const response = await fetch(`https://dev.to/api/${path}`, {
        headers: { 'api-key': token },
      });
      if (!response.ok) throw new Error('DEV organization lookup failed');
      return response.json();
    };
    const articles = await read('articles/me/all?per_page=1000');
    if (!Array.isArray(articles))
      throw new Error('Invalid DEV article response');
    const usernames = new Set<string>(
      articles.map((a: any) => a?.organization?.username).filter(Boolean)
    );
    const configured = [
      ...new Set(
        (process.env.DEVTO_ORGANIZATIONS || '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[a-z0-9_-]+$/i.test(s))
      ),
    ];
    if (configured.length) {
      const user = await read('users/me');
      if (!Number.isInteger(user.id))
        throw new Error('Invalid DEV user response');
      for (const username of configured) {
        if (usernames.has(username)) continue;
        const members = await read(
          `organizations/${encodeURIComponent(username)}/users?per_page=1000`
        );
        if (
          Array.isArray(members) &&
          members.some((member) => member.id === user.id)
        ) {
          usernames.add(username);
        }
      }
    }
    const result: { id: number; name: string; username: string }[] = [];
    for (const username of usernames) {
      const org = await read(`organizations/${encodeURIComponent(username)}`);
      if (!Number.isInteger(org.id) || org.username !== username) {
        throw new Error('Invalid DEV organization response');
      }
      result.push({ id: org.id, name: org.name, username: org.username });
    }
    return result;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { settings } = postDetails?.[0] || { settings: {} };
    const { id: postId, url } = await (
      await this.fetch(`https://dev.to/api/articles`, {
        method: 'POST',
        body: JSON.stringify({
          article: {
            title: settings.title,
            body_markdown: postDetails?.[0].message,
            published: true,
            ...(settings?.main_image?.path
              ? { main_image: settings?.main_image?.path }
              : {}),
            tags: settings?.tags?.map((t: any) => t.label),
            organization_id: settings.organization,
            ...(settings.canonical
              ? { canonical_url: settings.canonical }
              : {}),
          },
        }),
        headers: {
          'Content-Type': 'application/json',
          'api-key': accessToken,
        },
      })
    ).json();

    return [
      {
        id: postDetails?.[0].id,
        status: 'completed',
        postId: String(postId),
        releaseURL: url,
      },
    ];
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStudioCommand, cancelStudioCommand, applyCrawlFoundryContentCommand } from '../libraries/nestjs-libraries/src/database/prisma/posts/studio-command.ts';

const id = `studio-${'a'.repeat(64)}`;
const updatedAt = '2026-09-11T12:00:00.000Z';
const conflict = (code) => Object.assign(new Error(code), { status: 409 });
function command(expectedUpdatedAt = null) {
  return {
    state: 'draft',
    orgId: 'org-1',
    date: updatedAt,
    tags: [],
    creationMethod: 'API',
    body: {
      integration: { id: 'account-1' },
      value: [{ id, content: 'Useful fact', image: [] }],
      settings: {
        __type: 'linkedin',
        __studio: { version: 1, id, expectedUpdatedAt },
      },
    },
  };
}

test('ordinary Postiz commands retain the original path', async () => {
  const input = command();
  delete input.body.settings.__studio;
  assert.equal(await applyStudioCommand({}, input, conflict), undefined);
});

test('create uses the deterministic id and strips the private envelope', async () => {
  const result = await applyStudioCommand(
    {
      create: async ({ data }) => {
        assert.equal(data.id, id);
        assert.equal(data.organization.connect.id, 'org-1');
        assert.deepEqual(JSON.parse(data.settings), { __type: 'linkedin' });
        return { id };
      },
    },
    command(),
    conflict
  );
  assert.equal(result.posts[0].id, id);
});

test('stale, foreign or changed drafts never enter the upsert path', async () => {
  let updates = 0;
  const model = {
    update: async ({ where }) => {
      updates++;
      assert.deepEqual(where, {
        id,
        organizationId: 'org-1',
        integrationId: 'account-1',
        updatedAt: new Date(updatedAt),
        state: 'DRAFT',
        deletedAt: null,
        parentPostId: null,
        intervalInDays: null,
        childrenPost: { none: { deletedAt: null } },
      });
      throw Object.assign(new Error('private database detail'), {
        code: 'P2025',
      });
    },
  };
  await assert.rejects(
    applyStudioCommand(model, command(updatedAt), conflict),
    {
      message: 'studio_revision_conflict',
      status: 409,
    }
  );
  assert.equal(updates, 1);
});

test('duplicate create is a conflict without an update', async () => {
  await assert.rejects(
    applyStudioCommand(
      {
        create: async () => {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
      },
      command(),
      conflict
    ),
    { message: 'studio_revision_conflict' }
  );
});

test('publication requires an existing version and queues only after conditional update', async () => {
  const input = command();
  input.state = 'now';
  await assert.rejects(applyStudioCommand({}, input, conflict), {
    message: 'studio_invalid_command',
  });
  input.body.settings.__studio.expectedUpdatedAt = updatedAt;
  await applyStudioCommand(
    {
      update: async ({ data }) => {
        assert.equal(data.state, 'QUEUE');
        return { id };
      },
    },
    input,
    conflict
  );
});

test('managed schedule creates a queue item and reschedules only the known revision', async () => {
  const fresh = command();
  fresh.state = 'schedule';
  fresh.date = new Date(Date.now() + 120_000).toISOString();
  await applyStudioCommand(
    {
      create: async ({ data }) => {
        assert.equal(data.id, id);
        assert.equal(data.state, 'QUEUE');
        return { id };
      },
    },
    fresh,
    conflict
  );
  const revision = command(updatedAt);
  revision.state = 'schedule';
  revision.date = fresh.date;
  await applyStudioCommand(
    {
      update: async ({ where, data }) => {
        assert.deepEqual(where.state, { in: ['DRAFT', 'QUEUE'] });
        assert.equal(where.updatedAt.toISOString(), updatedAt);
        assert.equal(data.state, 'QUEUE');
        return { id };
      },
    },
    revision,
    conflict
  );
});

test('managed schedule refuses a due or past timestamp', async () => {
  const input = command();
  input.state = 'schedule';
  await assert.rejects(applyStudioCommand({}, input, conflict), {
    message: 'studio_invalid_command',
  });
});

test('managed cancellation requires an unchanged future queue item', async () => {
  await cancelStudioCommand(
    {
      update: async ({ where, data }) => {
        assert.equal(where.id, id);
        assert.equal(where.organizationId, 'org-1');
        assert.equal(where.group, id);
        assert.equal(where.updatedAt.toISOString(), updatedAt);
        assert.equal(where.state, 'QUEUE');
        assert.ok(where.publishDate.gt > new Date());
        assert.ok(data.deletedAt instanceof Date);
        return { id };
      },
    },
    { orgId: 'org-1', id, expectedUpdatedAt: updatedAt },
    conflict
  );
  await assert.rejects(
    cancelStudioCommand(
      { update: async () => { throw { code: 'P2025' }; } },
      { orgId: 'org-1', id, expectedUpdatedAt: updatedAt },
      conflict
    ),
    { message: 'studio_revision_conflict' }
  );
});

test('existing Crawl Foundry queue item is revised only with its live revision and provider', async () => {
  const date = new Date(Date.now() + 120_000).toISOString();
  await applyCrawlFoundryContentCommand(
    { update: async ({ where, data }) => {
      assert.equal(where.organizationId, 'org-1');
      assert.equal(where.updatedAt.toISOString(), updatedAt);
      assert.deepEqual(where.integration.providerIdentifier.in, ['crawlfoundry-blog', 'cfglossary']);
      assert.equal(data.publishDate.toISOString(), date);
      return { id: 'legacy-1', group: 'group-1' };
    } },
    { orgId: 'org-1', id: 'legacy-1', expectedUpdatedAt: updatedAt,
      action: 'schedule', date }, conflict
  );
  await assert.rejects(applyCrawlFoundryContentCommand(
    { update: async () => { throw { code: 'P2025' }; } },
    { orgId: 'org-1', id: 'legacy-1', expectedUpdatedAt: updatedAt,
      action: 'cancel' }, conflict
  ), { message: 'cf_revision_conflict' });
});

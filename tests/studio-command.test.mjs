import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStudioCommand } from '../libraries/nestjs-libraries/src/database/prisma/posts/studio-command.ts';

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

/** The Content Studio envelope is an opt-in, conditional write path. */
export async function applyStudioCommand(
  model: any,
  command: {
    state: string;
    orgId: string;
    date: string;
    body: any;
    tags: any[];
    creationMethod: string;
    inter?: number;
  },
  conflict: (code: string) => Error
) {
  const { state, orgId, date, body, tags, creationMethod, inter } = command;
  const guard = body.settings?.__studio;
  if (guard === undefined) return undefined;
  const value = body.value?.[0];
  if (
    creationMethod !== 'API' ||
    !['draft', 'now', 'schedule'].includes(state) ||
    body.value?.length !== 1 ||
    body.group ||
    inter ||
    tags.length ||
    guard?.version !== 1 ||
    !/^studio-[a-f0-9]{64}$/.test(guard.id ?? '') ||
    value?.id !== guard.id ||
    typeof value?.content !== 'string' ||
    !Array.isArray(value.image) ||
    !Number.isFinite(Date.parse(date)) ||
    (state === 'schedule' && Date.parse(date) < Date.now() + 60_000) ||
    !(
      guard.expectedUpdatedAt === null ||
      (typeof guard.expectedUpdatedAt === 'string' &&
        Number.isFinite(Date.parse(guard.expectedUpdatedAt)))
    ) ||
    (guard.expectedUpdatedAt === null && state === 'now')
  ) {
    throw conflict('studio_invalid_command');
  }
  const settings = { ...body.settings };
  delete settings.__studio;
  const data = {
    content: value.content,
    image: JSON.stringify(value.image),
    settings: JSON.stringify(settings),
    delay: 0,
    group: guard.id,
    publishDate: new Date(date),
    state: state === 'draft' ? 'DRAFT' : 'QUEUE',
    organization: { connect: { id: orgId } },
    integration: {
      connect: { id: body.integration.id, organizationId: orgId },
    },
  };
  try {
    const post =
      guard.expectedUpdatedAt === null
        ? await model.create({
            data: { ...data, id: guard.id, creationMethod: 'API' },
          })
        : await model.update({
            where: {
              id: guard.id,
              organizationId: orgId,
              integrationId: body.integration.id,
              updatedAt: new Date(guard.expectedUpdatedAt),
              state: state === 'draft' || state === 'now' ? 'DRAFT' : { in: ['DRAFT', 'QUEUE'] },
              deletedAt: null,
              parentPostId: null,
              intervalInDays: null,
              childrenPost: { none: { deletedAt: null } },
            },
            data,
          });
    return { posts: [post] };
  } catch (error: any) {
    if (error?.code === 'P2002' || error?.code === 'P2025') {
      throw conflict('studio_revision_conflict');
    }
    throw error;
  }
}

/** Cancel only the unchanged future queue item owned by this organization. */
export async function cancelStudioCommand(
  model: any,
  input: { orgId: string; id: string; expectedUpdatedAt: string },
  conflict: (code: string) => Error
) {
  if (
    !/^studio-[a-f0-9]{64}$/.test(input.id) ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt))
  ) {
    throw conflict('studio_invalid_command');
  }
  try {
    return await model.update({
      where: {
        id: input.id,
        organizationId: input.orgId,
        group: input.id,
        updatedAt: new Date(input.expectedUpdatedAt),
        state: 'QUEUE',
        deletedAt: null,
        publishDate: { gt: new Date(Date.now() + 60_000) },
        parentPostId: null,
        intervalInDays: null,
        childrenPost: { none: { deletedAt: null } },
      },
      data: { deletedAt: new Date() },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      throw conflict('studio_revision_conflict');
    }
    throw error;
  }
}

/** Guarded edits for the existing Crawl Foundry blog and glossary queue. */
export async function applyCrawlFoundryContentCommand(
  model: any,
  input: {
    orgId: string;
    id: string;
    expectedUpdatedAt: string;
    action: 'schedule' | 'cancel' | 'now';
    date?: string;
  },
  conflict: (code: string) => Error
) {
  const nextDate = input.action === 'now' ? new Date() :
    input.date == null ? null : new Date(input.date);
  if (
    !/^[a-zA-Z0-9_-]{1,200}$/.test(input.id) ||
    !['schedule', 'cancel', 'now'].includes(input.action) ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
    (input.action === 'schedule' &&
      (nextDate == null || !Number.isFinite(nextDate.getTime()) ||
        nextDate.getTime() < Date.now() + 60_000)) ||
    (input.action === 'now' && nextDate == null)
  ) {
    throw conflict('cf_invalid_command');
  }
  try {
    return await model.update({
      where: {
        id: input.id,
        organizationId: input.orgId,
        updatedAt: new Date(input.expectedUpdatedAt),
        state: 'QUEUE',
        deletedAt: null,
        publishDate: { gt: new Date(Date.now() + 60_000) },
        parentPostId: null,
        intervalInDays: null,
        childrenPost: { none: { deletedAt: null } },
        integration: {
          organizationId: input.orgId,
          providerIdentifier: { in: ['crawlfoundry-blog', 'cfglossary'] },
        },
      },
      data: input.action === 'cancel'
        ? { deletedAt: new Date() }
        : { publishDate: nextDate, state: 'QUEUE' },
      include: { integration: { select: { providerIdentifier: true } } },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') throw conflict('cf_revision_conflict');
    throw error;
  }
}

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
    !['draft', 'now'].includes(state) ||
    body.value?.length !== 1 ||
    body.group ||
    inter ||
    tags.length ||
    guard?.version !== 1 ||
    !/^studio-[a-f0-9]{64}$/.test(guard.id ?? '') ||
    value?.id !== guard.id ||
    typeof value?.content !== 'string' ||
    !Array.isArray(value.image) ||
    !(
      guard.expectedUpdatedAt === null ||
      (typeof guard.expectedUpdatedAt === 'string' &&
        Number.isFinite(Date.parse(guard.expectedUpdatedAt)))
    ) ||
    (guard.expectedUpdatedAt === null && state !== 'draft')
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
              state: 'DRAFT',
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import type { ProfileRevisionEntry } from '@cauce/store';
import { AuthError, AuthorizationError } from '../../auth.js';
import type { AgentContextHistoryDeps } from '../agent-context-history.routes.js';
import { validateContextRepositoryBinding, type ContextRepositoryBinding } from './binding.js';
import { assertContextCommit } from './git-reader.js';
import { inspectContextRepository, type ContextSourceSnapshot } from './inspect.js';
import { ContextRepositoryError, serializeSourceProfile } from './model.js';

export interface ContextRepositoryRouteDeps {
  readonly binding?: ContextRepositoryBinding;
  readonly authorize: AgentContextHistoryDeps['authorize'];
  readonly authorizeTarget: AgentContextHistoryDeps['authorizeTarget'];
  readonly readProfileRevision: (tenantId: string, alias: string, revision: number) => Promise<ProfileRevisionEntry | undefined>;
}

interface Params { tenantId: string; alias: string }
type Request = FastifyRequest<{ Params: Params; Querystring: Record<string, unknown> }>;
type JournalVerification = 'journal_match' | 'journal_mismatch' | 'journal_unavailable';

async function journalVerification(
  snapshot: ContextSourceSnapshot, deps: ContextRepositoryRouteDeps,
): Promise<JournalVerification> {
  const { scope, sourceAgent } = snapshot;
  const journal = await deps.readProfileRevision(scope.tenant_id, scope.alias, sourceAgent.source_journal.revision);
  if (journal === undefined) return 'journal_unavailable';
  if (journal.id !== sourceAgent.source_journal.id || journal.revision !== sourceAgent.source_journal.revision
    || journal.tenant_id !== scope.tenant_id || journal.alias !== scope.alias
    || (journal.operation !== 'insert' && journal.operation !== 'update')) return 'journal_mismatch';
  try {
    return serializeSourceProfile(journal, scope) === serializeSourceProfile(snapshot.profile, scope)
      ? 'journal_match' : 'journal_mismatch';
  } catch (error) {
    if (error instanceof ContextRepositoryError) return 'journal_mismatch';
    throw error;
  }
}

function replyFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
  } else if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: 'forbidden', message: 'Agent context access denied' });
  } else if (error instanceof ContextRepositoryError) {
    void reply.code(422).send({ error: 'context_snapshot_unavailable', reason: error.code });
  } else {
    void reply.code(503).send({ error: 'context_repository_unavailable', message: 'Context inspection unavailable' });
  }
}

export function registerContextRepositoryRoutes(app: FastifyInstance, deps: ContextRepositoryRouteDeps): void {
  const binding = deps.binding === undefined ? undefined : validateContextRepositoryBinding(deps.binding);
  const route = '/v3/console/tenants/:tenantId/agents/:alias/context/repository';

  async function authorizeTarget(request: Request, reply: FastifyReply) {
    const actor = await deps.authorize(request, 'read');
    const tenant = TenantSchema.safeParse(request.params.tenantId);
    const alias = AliasSchema.safeParse(request.params.alias);
    if (!tenant.success || !alias.success) {
      await reply.code(400).send({ error: 'invalid_input' });
      return undefined;
    }
    const target = await deps.authorizeTarget(actor, tenant.data, alias.data, 'read', false);
    if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
      await reply.code(404).send({ error: 'not_found', message: 'Agent not found or not visible' });
      return undefined;
    }
    return target;
  }

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(route, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const target = await authorizeTarget(request, reply);
      if (target === undefined) return undefined;
      if (Object.keys(request.query).length > 0) return await reply.code(400).send({ error: 'invalid_input' });
      return {
        tenant_id: target.tenant_id, alias: target.alias,
        state: binding === undefined ? 'not_configured' : 'configured',
        instance_id: binding?.instance_id ?? null,
        storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated',
      };
    } catch (error) { replyFailure(reply, error); return undefined; }
  });

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(`${route}/inspect`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const target = await authorizeTarget(request, reply);
      if (target === undefined) return undefined;
      const { commit, previous_commit } = request.query;
      if (Object.keys(request.query).some((key) => key !== 'commit' && key !== 'previous_commit')
        || typeof commit !== 'string' || (previous_commit !== undefined && typeof previous_commit !== 'string')) {
        return await reply.code(400).send({ error: 'invalid_input' });
      }
      assertContextCommit(commit);
      if (previous_commit !== undefined) assertContextCommit(previous_commit);
      if (binding === undefined) return await reply.code(409).send({ error: 'context_repository_not_configured' });
      const inspection = await inspectContextRepository({
        repositoryPath: binding.repositoryPath,
        scope: { instance_id: binding.instance_id, tenant_id: target.tenant_id, alias: target.alias },
        commit, ...(previous_commit === undefined ? {} : { previousCommit: previous_commit }),
      });
      const desired = await journalVerification(inspection.desired, deps);
      const previous = inspection.previous === null ? null : await journalVerification(inspection.previous, deps);
      if (await authorizeTarget(request, reply) === undefined) return undefined;
      return {
        tenant_id: target.tenant_id, alias: target.alias,
        ...inspection,
        journalVerification: { desired, previous },
      };
    } catch (error) { replyFailure(reply, error); return undefined; }
  });
}

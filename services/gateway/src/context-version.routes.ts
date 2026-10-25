import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { ContextGitBroker, ContextRejectedError, ContextVersionStore, ingestNativeContextVersion, processContextOutbox,
  requestContextApplication, settleContextApplications, StoreError, type ContextApplicationRuntime, type ContextTarget,
  type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, isAgentPrincipal, requirePermission, type AuthProvider } from './auth.js';
import { consoleHumanAccess } from './console-human-authority.js';
import { PasswordAuthProvider } from './password-auth.js';
import { principal, replyError } from './routes/shared.js';
import { registerContextRetirementRoutes } from './console/context-repository/retirement-routes.js';

const Params = z.object({ tenant: TenantSchema, alias: AliasSchema }).strict();
const Revision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const HistoryQuery = z.object({ before: Revision.optional() }).strict();
const DiffQuery = z.object({ from: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER), to: Revision }).strict();
export interface ContextVersionRouteOptions { readonly repositoryRoot?: string; readonly runtime?: ContextApplicationRuntime }
function sendRejection(reply: FastifyReply, error: ContextRejectedError): FastifyReply {
  const reason = error.reason === 'context_governed_path' && error.paths.includes('context/profile.json')
    ? 'profile_is_governed' : error.reason;
  const status = reason === 'profile_is_governed' ? 409 : reason === 'context_governed_path' ? 403
    : reason === 'context_harness_limit' || reason === 'context_too_large' ? 413 : 422;
  return reply.code(status).send({ error: reason, message: error.message, paths: error.paths, ...error.limit });
}
export function registerContextVersionRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  options: ContextVersionRouteOptions = {}): void {
  const store = new ContextVersionStore(pool);
  const root = options.repositoryRoot ?? process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  registerContextRetirementRoutes(app, provider, pool, root);
  const git = root === undefined ? undefined : new ContextGitBroker(root);
  let timer: NodeJS.Timeout | undefined; let running: Promise<void> | undefined;
  const run = async (target?: ContextTarget) => {
    for (let count = 0; count < 16; count++) {
      const result = await processContextOutbox(pool, { ...(git ? { git } : {}), ...(options.runtime ? { runtime: options.runtime } : {}) }, target);
      if (result.state === 'idle' || result.state === 'busy') break;
    }
  };
  const tick = (target?: ContextTarget) => {
    if (running) return;
    running = run(target).catch(() => { app.log.warn({ code: 'context_outbox_unavailable' }, 'Context outbox worker failed'); })
      .finally(() => { running = undefined; });
  };
  if (git || options.runtime) {
    app.addHook('onReady', async () => { timer = setInterval(() => { tick(); }, 5_000); timer.unref(); tick(); });
    app.addHook('onClose', async () => {
      clearInterval(timer); await running;
      await settleContextApplications(pool, { stopWaiting: true });
    });
  }
  app.post('/v3/context/ingest', { bodyLimit: 1_100_000 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actor = await principal(request, provider);
      requirePermission(actor, 'route');
      if (!isAgentPrincipal(actor) || actor.operator_id !== undefined) throw new AuthorizationError('native context ingest requires an agent principal');
      const result = await ingestNativeContextVersion(pool, actor.tenant_id, actor.alias, request.body);
      if (result.state === 'conflict') {
        return await reply.code(409).send({ error: 'context_version_conflict',
          message: 'the server context version advanced beyond the locally applied base; the local edit was not recorded',
          base_version: result.base_version, desired_version: result.desired_version, applied_version: result.applied_version,
          digest_exists_in_history: result.digest_exists_in_history });
      }
      if (result.state === 'rejected') return await sendRejection(reply, result.error);
      if (git || options.runtime) tick(result.snapshot);
      return await reply.code(202).send(result.snapshot);
    } catch (error) {
      if (error instanceof z.ZodError) return await reply.code(400).send({ error: 'invalid_request', message: 'invalid context ingest request' });
      if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) { replyError(reply, error); return; }
      throw error;
    }
  });
  const base = '/v3/console/context/agents/:tenant/:alias';
  for (const operation of ['read', 'write', 'history', 'diff', 'restore', 'retry', 'apply', 'status'] as const) {
    const method = operation === 'write' ? 'PUT' : ['restore', 'retry', 'apply'].includes(operation) ? 'POST' : 'GET';
    const suffix = ['read', 'write'].includes(operation) ? '' : operation === 'retry' ? '/sync/retry' : `/${operation}`;
    app.route({ method, url: `${base}${suffix}`, bodyLimit: 1_100_000, handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const target = Params.parse(request.params);
        if (['write','restore','retry','apply'].includes(operation) && provider instanceof PasswordAuthProvider) await provider.requireCsrf(request);
        const access = await consoleHumanAccess(provider, request, reply, 'read');
        if (!access) throw new AuthorizationError('a console session is required');
        const authority = access.companyAuthority.bind(access);
        try {
          if (operation === 'write') return await reply.code(202).send(await store.write(authority, target.tenant, target.alias, request.body));
          if (operation === 'restore') return await reply.code(202).send(await store.restore(authority, target.tenant, target.alias, request.body));
          if (operation === 'history') return await store.history(authority, target.tenant, target.alias, HistoryQuery.parse(request.query).before);
          if (operation === 'diff') { const query = DiffQuery.parse(request.query); return await store.diff(authority, target.tenant, target.alias, query.from, query.to); }
          if (operation === 'retry') return await reply.code(202).send(await store.retry(authority, target.tenant, target.alias));
          if (operation === 'apply') {
            const snapshot = await store.retry(authority, target.tenant, target.alias);
            if (!options.runtime) return await reply.code(503).send({ error: 'context_runtime_unavailable', snapshot });
            await requestContextApplication(pool, snapshot);
            const busy = running !== undefined;
            tick(snapshot);
            return await reply.code(202).send({ ...snapshot, operation: { state: busy ? 'busy' : 'pending', version: snapshot.desired_version } });
          }
          return await store.read(authority, target.tenant, target.alias);
        } finally { access.close(); }
      } catch (error) {
        if (error instanceof z.ZodError) return await reply.code(400).send({ error: 'invalid_request', message: 'invalid context request' });
        if (error instanceof ContextRejectedError) return await sendRejection(reply, error);
        if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) { replyError(reply, error); return; }
        throw error;
      }
    } });
  }
}

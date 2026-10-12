import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { QuotaAccountCreateSchema, QuotaAccountIdSchema } from '@cauce/protocol';
import { createQuotaAccount, deleteQuotaAccount, listQuotaAccounts, updateQuotaAccount, QuotaEnvironmentRepository,
  StoreError, type CompanyAuthoritySource, type DatabasePool, type QuotaEnvironmentOptions } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { replyError } from '../shared.js';
import { HostCapabilityRegistry } from '../../fleet/host-channel.capabilities.js';

const AccountParams = z.object({ id: QuotaAccountIdSchema }).strict();
const AccountCreate = QuotaAccountCreateSchema.extend({ provider: z.enum(['claude', 'codex', 'grok']) }).strict();
const EnvironmentParams = z.object({ id: z.uuid() }).strict();
const DeleteVersion = z.object({ expected_version: z.string().regex(/^[1-9][0-9]{0,15}$/u).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)) }).strict();

export function registerQuotaEnvironmentRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  options?: QuotaEnvironmentOptions): void {
  const registry = new HostCapabilityRegistry(pool);
  const environments = new QuotaEnvironmentRepository(pool, { approvedHostIds: [], providers: [], ...options,
    resolveCapabilities: options?.resolveCapabilities ?? (async (companyId, client) => {
      const signed = new Set((await client.query<{ host_id: string }>(
        'SELECT host_id FROM fleet_host_identities WHERE company_id=$1', [companyId])).rows.map(row => row.host_id));
      const actions = ['create','authenticate','query','update_cli','delete'] as const;
      const configuredProviders = (options?.providers ?? []).filter(value => value !== 'gemini');
      const configured = (options?.approvedHostIds ?? []).filter(host_id => !signed.has(host_id)).map(host_id => ({
        host_id, providers: configuredProviders,
        provider_actions: Object.fromEntries(configuredProviders.map(value => [value, actions])),
      }));
      const enrolled = (await registry.read(companyId)).filter(host => host.quota_executor_ready).map(host => {
        const providers = host.capabilities.quota_providers.filter(value => value !== 'gemini'
          && (host.capabilities.quota_provider_actions[value]?.length ?? 0) > 0);
        return { host_id: host.host_id, providers,
          provider_actions: Object.fromEntries(providers.map(value => [value, host.capabilities.quota_provider_actions[value] ?? []])) };
      });
      return [...configured, ...enrolled];
    }),
  });
  const handler = (work: (source: CompanyAuthoritySource, request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const access = await consoleHumanAccess(provider, request, reply, 'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try { return await work(client => access.companyAuthority(client), request); } finally { access.close(); }
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid quota request' });
      if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) { replyError(reply, error); return; }
      throw error;
    }
  };
  app.get('/v3/console/quota-accounts', handler(source => listQuotaAccounts(pool, source)));
  app.post('/v3/console/quota-accounts', handler((source, request) => createQuotaAccount(pool, source, AccountCreate.parse(request.body))));
  app.patch('/v3/console/quota-accounts/:id', handler((source, request) => updateQuotaAccount(pool, source, AccountParams.parse(request.params).id, request.body)));
  app.delete('/v3/console/quota-accounts/:id', handler((source, request) => deleteQuotaAccount(pool, source, AccountParams.parse(request.params).id,
    DeleteVersion.parse(request.query).expected_version)));
  app.get('/v3/console/quota-environments', handler(source => environments.list(source)));
  app.post('/v3/console/quota-environments', handler((source, request) => environments.create(source, request.body)));
  app.patch('/v3/console/quota-environments/:id', handler((source, request) => environments.update(source, EnvironmentParams.parse(request.params).id, request.body)));
  app.post('/v3/console/quota-environments/:id/actions', handler((source, request) => environments.action(source, EnvironmentParams.parse(request.params).id, request.body)));
  app.delete('/v3/console/quota-environments/:id', handler((source, request) => environments.action(source, EnvironmentParams.parse(request.params).id,
    { ...(request.body as Record<string, unknown>), action: 'delete' })));
}

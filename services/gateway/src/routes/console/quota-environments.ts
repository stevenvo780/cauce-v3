import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { QuotaAccountCreateSchema, QuotaAccountIdSchema, QuotaEnvironmentActionSchema } from '@cauce/protocol';
import { createQuotaAccount, deleteQuotaAccount, listQuotaAccounts, updateQuotaAccount, QuotaEnvironmentRepository,
  StoreError, type CompanyAuthoritySource, type DatabasePool, type QuotaEnvironmentOptions } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { driverErrorCode, replyError } from '../shared.js';
import { HostCapabilityRegistry } from '../../fleet/host-channel.capabilities.js';

const AccountParams = z.object({ id: QuotaAccountIdSchema }).strict();
const AccountCreate = QuotaAccountCreateSchema.extend({ provider: z.enum(['claude', 'codex', 'grok']) }).strict();
const EnvironmentParams = z.object({ id: z.uuid() }).strict();
const DeleteVersion = z.object({ expected_version: z.string().regex(/^[1-9][0-9]{0,15}$/u).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)) }).strict();
const DeleteEnvironment = DeleteVersion.extend({ idempotency_key: QuotaEnvironmentActionSchema.shape.idempotency_key }).strict();
type QuotaRefresh = Awaited<ReturnType<QuotaEnvironmentRepository['refreshStale']>>['refreshes'][number];

function accountRefreshStatus(refreshes: readonly QuotaRefresh[], accountId: string): QuotaRefresh['status'] | undefined {
  const statuses = new Set(refreshes.filter(refresh => refresh.account_id === accountId).map(refresh => refresh.status));
  return (['updating', 'fresh', 'busy', 'failed', 'stale', 'executor_unavailable', 'not_authenticated', 'read_only', 'deleted'] as const)
    .find(status => statuses.has(status));
}

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
      if (['23503', '23505', '23514'].includes(driverErrorCode(error) ?? '')) {
        return reply.code(409).send({ error: 'conflict', message: 'the change conflicts with existing data' });
      }
      throw error;
    }
  };
  app.get('/v3/console/quota-accounts', handler(async source => {
    const refresh = await environments.refreshStale(source);
    const snapshot = await listQuotaAccounts(pool, source);
    if (refresh.company_id !== snapshot.company_id) throw new StoreError('conflict', 'quota company authority changed');
    return { ...snapshot, accounts: snapshot.accounts.map(account => ({ ...account,
      refresh_status: accountRefreshStatus(refresh.refreshes, account.id) })) };
  }));
  app.post('/v3/console/quota-accounts', handler((source, request) => createQuotaAccount(pool, source, AccountCreate.parse(request.body))));
  app.patch('/v3/console/quota-accounts/:id', handler((source, request) => updateQuotaAccount(pool, source, AccountParams.parse(request.params).id, request.body)));
  app.delete('/v3/console/quota-accounts/:id', handler((source, request) => deleteQuotaAccount(pool, source, AccountParams.parse(request.params).id,
    DeleteVersion.parse(request.query).expected_version)));
  app.get('/v3/console/quota-environments', handler(source => environments.list(source, { refresh: true })));
  app.post('/v3/console/quota-environments', handler((source, request) => environments.create(source, request.body)));
  app.patch('/v3/console/quota-environments/:id', handler((source, request) => environments.update(source, EnvironmentParams.parse(request.params).id, request.body)));
  app.post('/v3/console/quota-environments/:id/actions', handler((source, request) => environments.action(source, EnvironmentParams.parse(request.params).id, request.body)));
  app.delete('/v3/console/quota-environments/:id', handler((source, request) => {
    z.undefined().parse(request.body);
    return environments.action(source, EnvironmentParams.parse(request.params).id,
      { ...DeleteEnvironment.parse(request.query), action: 'delete' });
  }));
}

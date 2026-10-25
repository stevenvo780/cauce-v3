import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, QuotaOperationsRepository, StoreError, assertQuotaAuthority, lockCompanyAuthority, withTransaction,
  type DatabaseClient, type DatabasePool, type QuotaOperationClaim } from '@cauce/store';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthLogin, ProviderAuthRequest, ProviderAuthService } from '../console/provider-auth.types.js';
import { QUOTA_AUTH_CLEANUP_GRACE_MS, QuotaAuthPacketSchema, type QuotaAuthCommand, type QuotaAuthEvent } from './quota-auth-contracts.js';

interface AuthScope {
  operation_id: string; environment_id: string; company_id: string; requested_by: string; host_id: string; account_id: string;
  provider: ProviderAuthRequest['provider_id']; claim_token: string; claim_epoch: number; worker_id: string;
  status: string; expires_at: string | null;
}
interface Pending {
  command: QuotaAuthCommand; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout>;
}
interface Entry {
  scope: AuthScope; claim: QuotaOperationClaim; expiresAt: string; method: 'device' | 'terminal';
  commands: Map<string, Pending>; listeners: Set<(bytes: Uint8Array) => void>; outputSequence: number;
  timer: ReturnType<typeof setTimeout>; finished: boolean;
}
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');
const unavailable = () => new ProviderAuthError('HOST_UNAVAILABLE');

async function readScope(client: DatabaseClient, id: string): Promise<AuthScope> {
  const row = (await client.query<AuthScope>(`SELECT op.id AS operation_id,op.environment_id,op.company_id,op.requested_by,
    op.claim_token,op.claim_epoch::int,op.worker_id,op.status,op.result->>'expires_at' AS expires_at,
    environment.host_id,environment.account_id,environment.provider FROM quota_environment_operations op
    JOIN quota_environments environment ON environment.id=op.environment_id AND environment.company_id=op.company_id
    JOIN provider_accounts account ON account.id=environment.account_id AND account.company_id=environment.company_id
    JOIN fleet_hosts host ON host.host_id=environment.host_id AND host.company_id=environment.company_id
    JOIN fleet_host_identities identity ON identity.host_id=host.host_id AND identity.company_id=host.company_id
    WHERE op.id=$1 AND op.action='authenticate' AND op.consent
      AND (account.enabled OR account.quota_registration_key IS NOT NULL AND account.quota_identity_hash IS NULL)
      AND account.canonical_account_id IS NULL AND host.enabled AND identity.enabled
      AND op.status IN ('running','awaiting_auth','done','failed') FOR SHARE OF op,environment,account,host,identity`, [id])).rows[0];
  if (!row?.claim_token || !row.worker_id) throw denied();
  return row;
}
function sameFence(entry: Entry, scope: AuthScope): boolean {
  return scope.operation_id === entry.claim.id && scope.environment_id === entry.claim.environment_id
    && scope.claim_token === entry.claim.claim_token && scope.claim_epoch === entry.claim.claim_epoch
    && scope.worker_id === entry.claim.worker_id && scope.company_id === entry.scope.company_id
    && scope.host_id === entry.scope.host_id && scope.provider === entry.scope.provider;
}

export class QuotaAuthBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly manager: ProviderAuthManager;
  readonly service: ProviderAuthService;
  constructor(private readonly pool: DatabasePool) {
    const manager = new ProviderAuthManager({
      authorize: async (actor, request) => { await this.current(actor, request); },
      authorizeTerminal: async (actor, request) => { await this.authorize(actor, request); },
      expiration: async (actor, request, maximum) => {
        const entry = await this.current(actor, request);
        return new Date(Math.min(Date.parse(maximum), Date.parse(entry.expiresAt))).toISOString();
      },
      reserve: async (actor, request, _sessionId, expiresAt) => {
        const entry = await this.current(actor, request);
        if (Date.parse(expiresAt) > Date.parse(entry.expiresAt)) throw new ProviderAuthError('SESSION_EXPIRED');
        return {
          stopAdapter: async () => ({ stopped: true }),
          openLogin: async () => this.login(entry),
          verify: async signal => {
            signal.throwIfAborted();
            await this.current(actor, request);
            if (!await this.command(entry, { id: randomUUID(), type: 'verify' })) throw new ProviderAuthError('FUNCTIONAL_CHECK_FAILED');
            const scope = await withTransaction(this.pool, client => readScope(client, entry.claim.id));
            const verified = sameFence(entry, scope) && scope.status === 'done';
            return { identity_matches: verified, functional_call_verified: verified };
          },
          release: async () => {
            entry.finished = true; clearTimeout(entry.timer);
            entry.timer = setTimeout(() => { this.dispose(entry); }, 900_000);
            entry.timer.unref();
          },
        };
      },
      audit: async metadata => {
        const entry = this.entries.get(metadata.operation_id);
        if (!entry) throw unavailable();
        await this.pool.query(`INSERT INTO audit_events(action,decision,company_id,metadata)
          VALUES('quota_environment.authentication',$1,$2,$3::jsonb)`,
        [metadata.error === null ? 'allow' : 'deny', entry.scope.company_id, JSON.stringify({ ...metadata,
          environment_id: entry.claim.environment_id, host_id: entry.scope.host_id, provider: entry.scope.provider })]);
      },
    }, { ttlMs: 600_000 });
    this.manager = manager;
    this.service = Object.assign(manager, { resolve: (actor: ProviderAuthActor, id: string) => this.resolve(actor, id) });
  }
  async ownsOperation(id: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM quota_environment_operations WHERE id=$1 AND action=\'authenticate\'', [z.uuid().parse(id)])).rowCount === 1;
  }
  private async authorize(actor: ProviderAuthActor, request: ProviderAuthRequest, requiresActive = false): Promise<Entry> {
    const entry = this.entries.get(request.operation_id);
    if (!entry) throw new ProviderAuthError('SESSION_EXPIRED');
    const humanId = /^console:([0-9a-f-]{36})$/u.exec(actor.subject)?.[1];
    if (!humanId) throw denied();
    await withTransaction(this.pool, async client => {
      const scope = await readScope(client, request.operation_id);
      const authority = await lockCompanyAuthority(client, { tenant: actor.tenant_id, alias: actor.alias,
        humanId, ...(actor.requestedCompany === undefined ? {} : { requestedCompany: actor.requestedCompany }) });
      assertQuotaAuthority(authority, true);
      if (!sameFence(entry, scope) || scope.requested_by !== humanId || authority.actingCompany !== scope.company_id
          || requiresActive && scope.status === 'failed' || request.expected_operation_version !== entry.claim.claim_epoch
          || request.host_id !== entry.scope.host_id || request.account_id !== entry.scope.account_id
          || request.profile_id !== entry.scope.account_id || request.provider_id !== entry.scope.provider
          || request.harness_id !== entry.scope.provider || request.runtime_user !== 'node') throw denied();
    });
    return entry;
  }
  private async current(actor: ProviderAuthActor, request: ProviderAuthRequest): Promise<Entry> {
    const entry = await this.authorize(actor, request, true);
    if (entry.finished || Date.now() >= Date.parse(entry.expiresAt)) throw new ProviderAuthError('SESSION_EXPIRED');
    return entry;
  }
  private async resolve(actor: ProviderAuthActor, id: string): Promise<ProviderAuthRequest> {
    const entry = this.entries.get(id);
    if (!entry) throw unavailable();
    const request: ProviderAuthRequest = { operation_id: id, expected_operation_version: entry.claim.claim_epoch,
      request_id: `quota_${id.replaceAll('-', '')}`, provider_id: entry.scope.provider, account_id: entry.scope.account_id,
      harness_id: entry.scope.provider, host_id: entry.scope.host_id, runtime_user: 'node', profile_id: entry.scope.account_id };
    await this.current(actor, request);
    return request;
  }
  register(scope: AuthScope, claim: QuotaOperationClaim, expiresAt: string, method: 'device' | 'terminal'): void {
    const expires = Date.parse(expiresAt);
    if (scope.status !== 'running' || !Number.isFinite(expires) || expires < Date.now() + 1000
        || expires > Date.now() + 900_000) throw unavailable();
    const previous = this.entries.get(claim.id);
    if (previous) {
      if (!isDeepStrictEqual(previous.claim, claim) || previous.expiresAt !== expiresAt || previous.method !== method) throw denied();
      return;
    }
    if (this.entries.size >= 1000) throw new ProviderAuthError('SESSION_CONFLICT');
    const timer = setTimeout(() => {
      const entry = this.entries.get(claim.id);
      if (entry) void this.manager.expireOperation(claim.id).then(found => { if (!found) this.dispose(entry); }).catch(() => undefined);
    }, expires - Date.now());
    timer.unref();
    this.entries.set(claim.id, { scope, claim, expiresAt, method, commands: new Map(), listeners: new Set(),
      outputSequence: 0, timer, finished: false });
  }
  exchange(scope: AuthScope, claim: QuotaOperationClaim, events: QuotaAuthEvent[]) {
    const entry = this.entries.get(claim.id);
    if (!entry || !isDeepStrictEqual(entry.claim, claim) || !sameFence(entry, scope)) throw denied();
    for (const event of events) {
      if (event.type === 'result') {
        const pending = entry.commands.get(event.id);
        if (!pending) continue;
        entry.commands.delete(event.id); clearTimeout(pending.timer); pending.resolve(event.ok);
      } else {
        if (event.sequence <= entry.outputSequence) continue;
        if (event.sequence !== entry.outputSequence + 1) throw denied();
        if (!entry.finished && Date.now() < Date.parse(entry.expiresAt)) {
          const bytes = Buffer.from(event.data, 'base64');
          for (const listener of entry.listeners) listener(bytes);
        }
        entry.outputSequence = event.sequence;
      }
    }
    return { commands: [...entry.commands.values()].map(value => value.command), output_sequence: entry.outputSequence,
      finished: entry.finished || Date.now() >= Date.parse(entry.expiresAt) + QUOTA_AUTH_CLEANUP_GRACE_MS };
  }
  private command(entry: Entry, command: QuotaAuthCommand): Promise<boolean> {
    const cleanup = command.type === 'close' || command.type === 'cancel';
    if (entry.commands.size >= 32 || !cleanup && (entry.finished || Date.now() >= Date.parse(entry.expiresAt))
        || cleanup && Date.now() >= Date.parse(entry.expiresAt) + QUOTA_AUTH_CLEANUP_GRACE_MS) return Promise.reject(unavailable());
    return new Promise(resolve => {
      // start waits for the helper's started event (60s on a cold container) and must not resolve first.
      const budget = command.type === 'verify' ? 120_000 : command.type === 'start' ? 90_000 : 15_000;
      const timer = setTimeout(() => { entry.commands.delete(command.id); resolve(false); }, budget);
      timer.unref(); entry.commands.set(command.id, { command, resolve, timer });
    });
  }
  private login(entry: Entry): ProviderAuthLogin & { cancel: ProviderAuthLogin['close'] } {
    return { method: entry.method,
      subscribeOutput: listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
      start: async () => { if (!await this.command(entry, { id: randomUUID(), type: 'start' })) throw unavailable(); },
      write: async bytes => { if (!await this.command(entry, { id: randomUUID(), type: 'input', data: Buffer.from(bytes).toString('base64') })) throw unavailable(); },
      resize: async (cols, rows) => { if (!await this.command(entry, { id: randomUUID(), type: 'resize', cols, rows })) throw unavailable(); },
      close: async () => ({ stopped: await this.command(entry, { id: randomUUID(), type: 'close' }) }),
      cancel: async () => ({ stopped: await this.command(entry, { id: randomUUID(), type: 'cancel' }) }),
    };
  }
  private dispose(entry: Entry): void {
    entry.finished = true; clearTimeout(entry.timer); entry.listeners.clear();
    for (const pending of entry.commands.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    entry.commands.clear(); this.entries.delete(entry.claim.id);
  }
  async shutdown(): Promise<void> {
    await this.service.shutdown();
    for (const entry of this.entries.values()) this.dispose(entry);
  }
}

export function registerQuotaAuthHostRoute(app: FastifyInstance, pool: DatabasePool, broker: QuotaAuthBroker): void {
  const identity = new HostEnrollmentRepository(pool);
  const quota = new QuotaOperationsRepository(pool);
  app.post<{ Params: { host_id: string } }>('/v3/fleet/hosts/:host_id/quota-auth', { bodyLimit: 262_144 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (request.headers.cookie !== undefined) throw denied();
      const hostId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u).parse(request.params.host_id);
      const verified = await identity.request(hostId, 'POST', `/v3/fleet/hosts/${hostId}/quota-auth`, request.body,
        async (client, host) => {
          const packet = QuotaAuthPacketSchema.parse((request.body as { payload: unknown }).payload);
          const scope = await readScope(client, packet.claim.id);
          if (scope.host_id !== host.host_id || scope.company_id !== host.company_id) throw denied();
          if (packet.action === 'register') {
            await quota.forTransaction(client).assertHostScopeInTransaction(client, packet.claim, host);
            await quota.forTransaction(client).execution(packet.claim);
          }
          return { packet, scope };
        });
      if (verified.packet.action === 'register') {
        broker.register(verified.scope, verified.packet.claim, verified.packet.expires_at, verified.packet.method);
        return { registered: true };
      }
      return broker.exchange(verified.scope, verified.packet.claim, verified.packet.events);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof ProviderAuthError || error instanceof StoreError ? 403 : 503;
      return reply.code(status).send({ error: 'quota_auth_unavailable', message: 'No se pudo acreditar la sesión de autenticación.' });
    }
  });
  app.addHook('onClose', () => broker.shutdown());
}

import { normalize } from 'node:path';
import { z } from 'zod';
import { loadFleetHostScope, withTransaction, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { assertProviderAuthSealedScope, loadProviderAuthRoutingScope } from '../console/provider-auth-binding.js';
import { ProviderAuthError, ProviderAuthRequestSchema, ProviderAuthSessionIdSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthService, ProviderAuthSnapshot } from '../console/provider-auth.types.js';
import { HostProviderAuthService } from './auth-bridge-client.js';
import { HostActorSchema } from './auth-bridge-contracts.js';
import type { AuthBridgeSocketPolicy } from './auth-bridge-socket.js';

export interface FleetProviderAuthRouterOptions {
  hosts: { host_id: string; socket_path: string; socket_policy?: AuthBridgeSocketPolicy }[];
}
const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const User = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u);
const SocketPolicy = z.object({ ownerUid: z.number().int().nonnegative().optional(), groupGid: z.number().int().nonnegative().optional() }).strict();
const Options = z.object({ hosts: z.array(z.object({ host_id: Identifier,
  socket_path: z.string().refine(value => value.startsWith('/') && normalize(value) === value && !/[\p{Cc}]/u.test(value)),
  socket_policy: SocketPolicy.optional() }).strict()).min(1).max(100) }).strict().refine(value =>
  new Set(value.hosts.map(host => host.host_id)).size === value.hosts.length
    && new Set(value.hosts.map(host => host.socket_path)).size === value.hosts.length);
const Reservation = z.object({ session_id: z.uuid(), actor_subject: HostActorSchema.shape.subject, cohort: z.string().max(512),
  expires_at: z.iso.datetime(), state: z.enum(['reserved', 'released']) }).strict();
const Audit = z.object({ session_id: z.uuid(), actor_subject: HostActorSchema.shape.subject, operation_id: z.uuid(),
  status: z.enum(['opening', 'awaiting_login', 'verifying', 'authenticated', 'cancelled', 'expired', 'failed']), error: z.string().nullable() }).strict();
const Metadata = z.object({ provider_auth: Reservation.optional(), provider_auth_status: Audit.optional() }).loose();
const Cohort = z.tuple([Identifier, User, Identifier]);
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');
const conflict = () => new ProviderAuthError('SESSION_CONFLICT');
type RoutingScope = Awaited<ReturnType<typeof loadProviderAuthRoutingScope>>;
interface SessionScope { value: RoutingScope; reservation: z.infer<typeof Reservation> }
function actorValid(actor: ProviderAuthActor): void { if (!HostActorSchema.safeParse(actor).success) throw denied(); }
function cohort(value: string) {
  try { return Cohort.parse(JSON.parse(value)); } catch { throw conflict(); }
}
function matches(value: RoutingScope, request: { operation_id: string; provider_id: string; account_id: string; harness_id: string;
  host_id: string; runtime_user: string; profile_id: string }): void {
  if (request.operation_id !== value.operation.id || request.host_id !== value.sealed.host_id || request.account_id !== value.account.id
      || request.profile_id !== value.account.id || request.provider_id !== value.account.provider
      || request.harness_id !== value.agent.harness_id || request.runtime_user !== value.agent.runtime_user) throw denied();
}
function reservations(rows: { operation_id: string; metadata: unknown }[], sessionId?: string) {
  const parsed = rows.map(row => {
    const value = Metadata.safeParse(row.metadata);
    if (!value.success) throw conflict();
    return { operation_id: row.operation_id, ...value.data };
  });
  const origins = parsed.flatMap(row => row.provider_auth === undefined ? [] : [{ operation_id: row.operation_id, reservation: row.provider_auth }]);
  if (!origins.length) throw denied();
  const origin = origins[0]; if (!origin) throw denied();
  for (const row of origins) {
    if (row.operation_id !== origin.operation_id || row.reservation.actor_subject !== origin.reservation.actor_subject
        || row.reservation.cohort !== origin.reservation.cohort
        || (sessionId !== undefined && (row.reservation.session_id !== sessionId || row.reservation.expires_at !== origin.reservation.expires_at))) throw conflict();
  }
  for (const row of parsed) if (row.provider_auth_status && (row.provider_auth_status.operation_id !== origin.operation_id
      || row.provider_auth_status.actor_subject !== origin.reservation.actor_subject || row.provider_auth_status.session_id !== sessionId)) throw conflict();
  return origin;
}
export function createFleetProviderAuthRouter(pool: DatabasePool, options: FleetProviderAuthRouterOptions): ProviderAuthService & {
  resolve: NonNullable<ProviderAuthService['resolve']>;
} {
  const parsed = Options.safeParse(options); if (!parsed.success) throw new ProviderAuthError('INVALID_REQUEST');
  const hosts = new Map(parsed.data.hosts.map(host => {
    const policy: AuthBridgeSocketPolicy = { ownerUid: host.socket_policy?.ownerUid ?? 0,
      ...(host.socket_policy?.groupGid === undefined ? {} : { groupGid: host.socket_policy.groupGid }) };
    return [host.host_id, new HostProviderAuthService(host.socket_path, policy)] as const;
  }));
  const host = (id: string) => { const service = hosts.get(id); if (!service) throw new ProviderAuthError('HOST_UNAVAILABLE'); return service; };
  const operation = async (actor: ProviderAuthActor, id: string): Promise<RoutingScope> => {
    actorValid(actor); if (!ProviderAuthSessionIdSchema.safeParse(id).success) throw new ProviderAuthError('INVALID_REQUEST');
    return withTransaction(pool, client => loadProviderAuthRoutingScope(client, actor, id));
  };
  const session = async (actor: ProviderAuthActor, id: string): Promise<SessionScope> => {
    actorValid(actor); if (!ProviderAuthSessionIdSchema.safeParse(id).success) throw new ProviderAuthError('INVALID_REQUEST');
    return withTransaction(pool, async client => {
      const rows = (await client.query<{ operation_id: string; metadata: unknown }>(`SELECT operation_id,metadata FROM fleet_operation_events
        WHERE metadata->'provider_auth'->>'session_id'=$1 OR metadata->'provider_auth_status'->>'session_id'=$1 ORDER BY id`, [id])).rows;
      const origin = reservations(rows, id);
      if (origin.reservation.actor_subject !== actor.subject) throw denied();
      const value = await loadProviderAuthRoutingScope(client, actor, origin.operation_id);
      const [hostId, user, profile] = cohort(origin.reservation.cohort);
      if (hostId !== value.sealed.host_id || user !== value.agent.runtime_user || profile !== value.account.id) throw denied();
      return { value, reservation: origin.reservation };
    });
  };
  const snapshot = (value: SessionScope, id: string, response: ProviderAuthSnapshot) => {
    matches(value.value, response);
    if (response.session_id !== id || response.expires_at !== value.reservation.expires_at) throw denied();
    return response;
  };
  const readSession = async (action: 'get' | 'verify' | 'cancel', actor: ProviderAuthActor, id: string) => {
    const value = await session(actor, id);
    const response = await host(value.value.sealed.host_id)[action](actor, id);
    return snapshot(await session(actor, id), id, response);
  };
  return {
    resolve: async (actor, id) => {
      const value = await operation(actor, id); const response = await host(value.sealed.host_id).resolve(actor, id);
      matches(await operation(actor, id), response); return response;
    },
    start: async (actor, input) => {
      const request = ProviderAuthRequestSchema.safeParse(input); if (!request.success) throw new ProviderAuthError('INVALID_REQUEST');
      const value = await operation(actor, request.data.operation_id); matches(value, request.data);
      const response = await host(value.sealed.host_id).start(actor, request.data);
      matches(value, response); matches(await operation(actor, request.data.operation_id), response);
      return snapshot(await session(actor, response.session_id), response.session_id, response);
    },
    get: (actor, id) => readSession('get', actor, id), verify: (actor, id) => readSession('verify', actor, id), cancel: (actor, id) => readSession('cancel', actor, id),
    issueSocketTicket: async (actor, id) => { const value = await session(actor, id); return host(value.value.sealed.host_id).issueSocketTicket(actor, id); },
    consumeSocketTicket: async (actor, id, ticket) => { const value = await session(actor, id); await host(value.value.sealed.host_id).consumeSocketTicket(actor, id, ticket); },
    attach: async (actor, id, output) => {
      const value = await session(actor, id); const channel = await host(value.value.sealed.host_id).attach(actor, id, output);
      const check = async () => {
        try {
          const current = await session(actor, id);
          if (current.reservation.cohort !== value.reservation.cohort || current.value.sealed.target_sha256 !== value.value.sealed.target_sha256) throw denied();
        } catch (error) { await channel.close(); throw error; }
      };
      return { input: async bytes => { await check(); await channel.input(bytes); },
        resize: async (cols, rows) => { await check(); await channel.resize(cols, rows); }, close: () => channel.close() };
    },
    revokeOperation: async id => {
      if (!ProviderAuthSessionIdSchema.safeParse(id).success) throw new ProviderAuthError('INVALID_REQUEST');
      const hostId = await withTransaction(pool, async client => {
        const rows = (await client.query<{ operation_id: string; metadata: unknown }>(`SELECT operation_id,metadata FROM fleet_operation_events
          WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id`, [id])).rows;
        if (!rows.length) return undefined;
        const origin = reservations(rows);
        const [hostId, user, profile] = cohort(origin.reservation.cohort);
        const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1 FOR SHARE', [id])).rows[0];
        if (row?.target.resource !== 'agent') throw denied();
        const sealed = await loadFleetHostScope(client, row, hostId);
        const agent = sealed.agents.find(value => value.tenant_id === row.target.tenant_id && row.target.resource === 'agent' && value.alias === row.target.alias);
        if (agent?.runtime_user !== user || agent.primary_account_id !== profile) throw denied();
        await assertProviderAuthSealedScope(client, row, agent); return hostId;
      });
      if (hostId !== undefined) await host(hostId).revokeOperation(id);
    },
    shutdown: async () => { for (const service of hosts.values()) await service.shutdown(); },
  };
}

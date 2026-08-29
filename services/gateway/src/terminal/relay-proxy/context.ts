import { createHash, timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthorizedAgentTarget, DatabaseClient, DatabasePool,
} from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import type { TerminalAuditEntry } from '../audit.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetPlacement,
  loadFleetPlacements,
} from '../authority.js';
import type { TerminalConfig } from '../config.js';
import { AgentRegistry, type RelayProcessIdentity } from '../registry.js';
import { ticketSha256 } from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';

export const CLAIM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const PRESENCE_KEYS = ['agents', 'relay_boot_id', 'relay_instance_id'] as const;
const CONSUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'ticket'] as const;
const AUTHZ_KEYS = ['claim_epoch', 'claim_token', 'relay_boot_id', 'relay_instance_id'] as const;
const RESUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'resume_token'] as const;
const RESUME_WITH_EPOCH_KEYS = [...RESUME_KEYS, 'claim_epoch'].sort();
const CLOSE_KEYS = ['bytes_in', 'bytes_out', 'exit_code', 'reason', 'relay_boot_id', 'relay_instance_id'] as const;
const CLOSE_WITH_CLAIM_KEYS = [...CLOSE_KEYS, 'claim_epoch', 'claim_token'].sort();

function authenticatedRelayInstanceId(request: FastifyRequest): string | undefined {
  const socket = request.raw.socket;
  if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized) return undefined;
  const certificate = socket.getPeerX509Certificate();
  if (certificate === undefined || certificate.raw.byteLength === 0) return undefined;
  return createHash('sha256').update(certificate.raw).digest('hex');
}

function relayProcessIdentity(
  record: Record<string, unknown>,
  peerInstanceId: string | undefined,
  allowedInstanceIds: ReadonlySet<string>,
): RelayProcessIdentity | undefined {
  const relayInstanceId = record.relay_instance_id;
  const relayBootId = record.relay_boot_id;
  if (typeof relayInstanceId !== 'string' || !/^[0-9a-f]{64}$/.test(relayInstanceId)
      || typeof relayBootId !== 'string' || !CLAIM_UUID_PATTERN.test(relayBootId)
      || relayBootId[14] !== '4'
      || peerInstanceId !== relayInstanceId || !allowedInstanceIds.has(relayInstanceId)) {
    return undefined;
  }
  return { relay_instance_id: relayInstanceId, relay_boot_id: relayBootId };
}

function relayClaimToken(value: unknown): string | undefined {
  return typeof value === 'string' && CLAIM_UUID_PATTERN.test(value) ? value : undefined;
}

/** Fence epochs stay decimal strings on the wire and in node-postgres; Number is never involved. */
export function relayClaimEpoch(value: unknown): string | undefined {
  if (typeof value !== 'string' || !POSITIVE_BIGINT_PATTERN.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}

function databaseClaimEpoch(value: string): string {
  const epoch = relayClaimEpoch(value);
  if (epoch === undefined) throw new Error('database terminal claim epoch is invalid');
  return epoch;
}

function boundedMilliseconds(later: Date, earlier: Date, maximum: number): number {
  const value = Math.ceil(later.getTime() - earlier.getTime());
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('database terminal claim lease is invalid');
  }
  return value;
}

function relayAuthorized(request: FastifyRequest, expected: string): boolean {
  const header: unknown = request.headers.authorization;
  const authorization = typeof header === 'string' ? header : undefined;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  // Compare digests: constant time, and a length mismatch never throws nor leaks the length.
  return timingSafeEqual(ticketSha256(authorization.slice(7)), ticketSha256(expected));
}

function counterValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

interface TerminalRelayRepository {
  authorizeAgentTarget(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: 'read' | 'control',
  ): Promise<AuthorizedAgentTarget | undefined>;
}

type FleetCohort = ReturnType<typeof containerCohort>;

export interface TerminalRelayProxyOptions {
  readonly pool: DatabasePool;
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly grants: GrantStore;
  readonly repository: TerminalRelayRepository;
  readonly relayPeerInstanceId: ((request: FastifyRequest) => string | undefined) | undefined;
  readonly UUID_PATTERN: RegExp;
  readonly exactObjectKeys: (
    record: Record<string, unknown>,
    expected: readonly string[],
  ) => boolean;
  readonly boundedInteger: (value: unknown, min: number, max: number, name: string) => number;
  readonly cohortLabels: (cohort: FleetCohort) => string[];
  readonly sessionExpiry: (row: TerminalSessionRow) => Date | undefined;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
  readonly recordTransactionalTerminalAudit: (
    client: DatabaseClient,
    entry: TerminalAuditEntry,
  ) => Promise<void>;
}

interface CurrentSessionPolicy {
  readonly allowed: boolean;
  readonly reason: string;
  readonly actor_tenant?: string;
  readonly actor_alias?: string;
  readonly cohort?: FleetCohort;
  readonly source_room_ids?: readonly string[];
}

export interface RelayProxyContext {
  readonly app: FastifyInstance;
  readonly pool: DatabasePool;
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly UUID_PATTERN: RegExp;
  readonly exactObjectKeys: (
    record: Record<string, unknown>,
    expected: readonly string[],
  ) => boolean;
  readonly boundedInteger: (
    value: unknown,
    min: number,
    max: number,
    name: string,
  ) => number;
  readonly cohortLabels: (cohort: FleetCohort) => string[];
  readonly sessionExpiry: (row: TerminalSessionRow) => Date | undefined;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
  readonly recordTransactionalTerminalAudit: (
    client: DatabaseClient,
    entry: TerminalAuditEntry,
  ) => Promise<void>;
  readonly PRESENCE_KEYS: typeof PRESENCE_KEYS;
  readonly CONSUME_KEYS: typeof CONSUME_KEYS;
  readonly AUTHZ_KEYS: typeof AUTHZ_KEYS;
  readonly RESUME_KEYS: typeof RESUME_KEYS;
  readonly RESUME_WITH_EPOCH_KEYS: typeof RESUME_WITH_EPOCH_KEYS;
  readonly CLOSE_KEYS: typeof CLOSE_KEYS;
  readonly CLOSE_WITH_CLAIM_KEYS: typeof CLOSE_WITH_CLAIM_KEYS;
  readonly requestRelayIdentity: (
    request: FastifyRequest,
    record: Record<string, unknown>,
    requireAcceptedPresence?: boolean,
  ) => RelayProcessIdentity | undefined;
  readonly relayGrant: (
    row: TerminalSessionRow,
    resumeToken: string,
    claimToken: string,
    databaseNow: Date,
    identity: RelayProcessIdentity,
  ) => Record<string, unknown>;
  readonly sessionActor: (
    row: TerminalSessionRow,
  ) => { tenant_id: string; alias: string } | undefined;
  readonly currentSessionPolicy: (
    row: TerminalSessionRow,
    freshGrants?: boolean,
    database?: DatabaseClient,
  ) => Promise<CurrentSessionPolicy>;
  readonly relayAuthorized: (request: FastifyRequest, expected: string) => boolean;
  readonly relayClaimToken: (value: unknown) => string | undefined;
  readonly relayClaimEpoch: (value: unknown) => string | undefined;
  readonly databaseClaimEpoch: (value: string) => string;
  readonly boundedMilliseconds: (later: Date, earlier: Date, maximum: number) => number;
  readonly counterValue: (value: string | number) => number;
}

export function createRelayProxyContext(
  app: FastifyInstance,
  options: TerminalRelayProxyOptions,
): RelayProxyContext {
  const {
    pool, config, registry, grants, repository, UUID_PATTERN, exactObjectKeys, boundedInteger,
    cohortLabels, sessionExpiry, replyError, recordTransactionalTerminalAudit,
  } = options;
  const peerInstanceId = options.relayPeerInstanceId ?? authenticatedRelayInstanceId;
  function requestRelayIdentity(
    request: FastifyRequest,
    record: Record<string, unknown>,
    requireAcceptedPresence = true,
  ): RelayProcessIdentity | undefined {
    const identity = relayProcessIdentity(record, peerInstanceId(request), config.relayInstanceIds);
    if (identity === undefined || (requireAcceptedPresence && !registry.accepts(identity))) return undefined;
    return identity;
  }

  function relayGrant(
    row: TerminalSessionRow,
    resumeToken: string,
    claimToken: string,
    databaseNow: Date,
    identity: RelayProcessIdentity,
  ): Record<string, unknown> {
    const expiry = sessionExpiry(row) ?? row.expires_at;
    if (row.relay_claim_sha256 === null || row.relay_claim_expires_at === null
        || !ticketSha256(claimToken).equals(row.relay_claim_sha256)) {
      throw new Error('database terminal claim does not match the relay receipt');
    }
    const claimEpoch = databaseClaimEpoch(row.relay_claim_epoch);
    if (row.relay_instance_id !== identity.relay_instance_id
        || row.relay_boot_id !== identity.relay_boot_id) {
      throw new Error('database terminal relay owner does not match the authenticated process');
    }
    const claimLeaseMs = boundedMilliseconds(
      row.relay_claim_expires_at,
      databaseNow,
      config.claimLeaseSeconds * 1_000,
    );
    return {
      ok: true,
      tenant_id: row.tenant_id,
      alias: row.alias,
      mode: row.mode,
      cols: row.cols,
      rows: row.rows,
      operator_id: row.operator_id,
      container: row.container,
      runtime_user: row.runtime_user,
      expires_at: row.expires_at.toISOString(),
      session_expires_at: expiry.toISOString(),
      // Capability-like: never log/audit this field and never persist it outside the 0600 relay
      // close spool. PostgreSQL holds only its SHA-256 digest.
      claim_token: claimToken,
      claim_epoch: claimEpoch,
      claim_lease_ms: claimLeaseMs,
      claim_lease_ttl_ms: config.claimLeaseSeconds * 1_000,
      relay_instance_id: identity.relay_instance_id,
      relay_boot_id: identity.relay_boot_id,
      // Never persisted or logged; only crosses relay mTLS and the authenticated browser WS (`ready`).
      resume_token: resumeToken
    };
  }

  function sessionActor(row: TerminalSessionRow): { tenant_id: string; alias: string } | undefined {
    const separator = row.console_subject.indexOf(':');
    if (separator <= 0 || separator !== row.console_subject.lastIndexOf(':')
        || separator === row.console_subject.length - 1) return undefined;
    return {
      tenant_id: row.console_subject.slice(0, separator),
      alias: row.console_subject.slice(separator + 1),
    };
  }

  /** Same canonical visibility rule as CauceRepository, executed on the already-held TX client. */
  async function authorizeAgentTargetInTransaction(
    database: DatabaseClient,
    actorTenant: string,
    actorAlias: string,
    targetTenant: string,
    targetAlias: string,
  ): Promise<AuthorizedAgentTarget | undefined> {
    const result = await database.query<AuthorizedAgentTarget>(
      `SELECT agent.tenant_id,agent.alias,agent.harness_id,agent.home_directory,agent.enabled
         FROM agents agent
         JOIN tenants target_tenant ON target_tenant.id=agent.tenant_id
        WHERE agent.tenant_id=$3 AND agent.alias=$4 AND target_tenant.enabled
          AND agent.enabled
          AND EXISTS (
            SELECT 1
              FROM memberships actor_membership
              JOIN role_policies actor_role ON actor_role.role=actor_membership.role
              JOIN tenants actor_tenant ON actor_tenant.id=actor_membership.tenant_id
              JOIN rooms actor_room
                ON actor_room.id=actor_membership.room_id
               AND actor_room.tenant_id=actor_membership.tenant_id
             WHERE actor_membership.tenant_id=$1 AND actor_membership.alias=$2
               AND actor_membership.enabled AND actor_role.allow_control
               AND actor_tenant.enabled AND actor_room.enabled
          )
          AND (
            $1=$3
            OR EXISTS (
              SELECT 1
                FROM acl_edges edge
                JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
               WHERE edge.from_tenant=$1 AND edge.to_tenant=$3
                 AND edge.enabled AND edge.allow_control
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
        LIMIT 1`,
      [actorTenant, actorAlias, targetTenant, targetAlias],
    );
    return result.rows[0];
  }

  /**
   * Live canonical policy shared by consume, resume and periodic authz. `freshGrants` is used by
   * consume so withdrawing the file between issuance and redemption has no cache window at all.
   */
  async function currentSessionPolicy(
    row: TerminalSessionRow,
    freshGrants = false,
    database?: DatabaseClient,
  ): Promise<CurrentSessionPolicy> {
    const actor = sessionActor(row);
    if (actor === undefined) return { allowed: false, reason: 'unknown_session' };
    const placements = await loadFleetPlacements(database ?? pool);
    const placement = fleetPlacement(placements, row.tenant_id, row.alias);
    if (placement === undefined) {
      return { allowed: false, reason: 'target_placement_changed' };
    }
    // row.container is the PHYSICAL ID of the presence; a recreated container is caught here.
    const vivo = registry.resolve(row.tenant_id, row.alias);
    const observado = vivo.status === 'online' || vivo.status === 'offline'
      ? vivo.observation : undefined;
    if (observado !== undefined && observado.presence.container_id !== row.container) {
      return { allowed: false, reason: 'target_placement_changed' };
    }
    const cohort = containerCohort(placements, row.tenant_id, row.alias);
    for (const member of cohort) {
      if (!attributionAllows(row.attributed, actor.tenant_id, member.tenant_id)) {
        return { allowed: false, reason: 'attribution_required' };
      }
      const visible = database === undefined
        ? await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, member.tenant_id, member.alias, 'control',
        )
        : await authorizeAgentTargetInTransaction(
          database, actor.tenant_id, actor.alias, member.tenant_id, member.alias,
        );
      if (visible === undefined) return { allowed: false, reason: 'control_authority_revoked' };
    }
    const authority = await cohortRoutingAuthority(
      database ?? pool, actor.tenant_id, actor.alias, cohort,
    );
    if (!authority.allowed) return { allowed: false, reason: 'no_routing_authority' };
    const grantStore = freshGrants
      ? new GrantStore(config.grantsFile, (message) => app.log.warn(message))
      : grants;
    if (!(await grantStore.allowsCohort(row.operator_id, cohort, row.mode))) {
      return { allowed: false, reason: 'no_grant' };
    }
    return {
      allowed: true,
      reason: 'ok',
      actor_tenant: actor.tenant_id,
      actor_alias: actor.alias,
      cohort,
      source_room_ids: authority.source_room_ids,
    };
  }

  return {
    app,
    pool,
    config,
    registry,
    UUID_PATTERN,
    exactObjectKeys,
    boundedInteger,
    cohortLabels,
    sessionExpiry,
    replyError,
    recordTransactionalTerminalAudit,
    PRESENCE_KEYS,
    CONSUME_KEYS,
    AUTHZ_KEYS,
    RESUME_KEYS,
    RESUME_WITH_EPOCH_KEYS,
    CLOSE_KEYS,
    CLOSE_WITH_CLAIM_KEYS,
    requestRelayIdentity,
    relayGrant,
    sessionActor,
    currentSessionPolicy,
    relayAuthorized,
    relayClaimToken,
    relayClaimEpoch,
    databaseClaimEpoch,
    boundedMilliseconds,
    counterValue,
  };
}

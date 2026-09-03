import { createHash, timingSafeEqual } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import { isCanonicalUuidV4 } from '@cauce/protocol';
import type { TerminalAuditEntry } from '../audit.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetPlacement,
  loadFleetPlacements,
} from '../authority.js';
import type { TerminalConfig } from '../config.js';
import {
  sessionExpiry, type AgentTargetRepository, type FleetCohort,
} from '../helpers.js';
import { AgentRegistry, type RelayProcessIdentity } from '../registry.js';
import { ticketSha256 } from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';
import { isAuthorizedTlsSocket } from '../../runtime-guards.js';
import {
  databaseClaimEpoch, relayClaimEpoch,
} from './claim-transition.js';

const PRESENCE_KEYS = ['agents', 'relay_boot_id', 'relay_instance_id'] as const;
const CONSUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'ticket'] as const;
const AUTHZ_KEYS = ['claim_epoch', 'claim_token', 'relay_boot_id', 'relay_instance_id'] as const;
const RESUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'resume_token'] as const;
const RESUME_WITH_EPOCH_KEYS = [...RESUME_KEYS, 'claim_epoch'].sort();
const CLOSE_KEYS = ['bytes_in', 'bytes_out', 'exit_code', 'reason', 'relay_boot_id', 'relay_instance_id'] as const;
const CLOSE_WITH_CLAIM_KEYS = [...CLOSE_KEYS, 'claim_epoch', 'claim_token'].sort();
const CLOSE_RECORDING_KEYS = ['input_batches', 'recording_capped', 'recording_sha256'] as const;
const CLOSE_WITH_RECORDING_KEYS = [...CLOSE_KEYS, ...CLOSE_RECORDING_KEYS].sort();
const CLOSE_WITH_CLAIM_AND_RECORDING_KEYS = [
  ...CLOSE_WITH_CLAIM_KEYS, ...CLOSE_RECORDING_KEYS,
].sort();

function authenticatedRelayInstanceId(request: FastifyRequest): string | undefined {
  const socket = request.raw.socket;
  if (!isAuthorizedTlsSocket(socket)) return undefined;
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
      || !isCanonicalUuidV4(relayBootId)
      || peerInstanceId !== relayInstanceId || !allowedInstanceIds.has(relayInstanceId)) {
    return undefined;
  }
  return { relay_instance_id: relayInstanceId, relay_boot_id: relayBootId };
}

function relayClaimToken(value: unknown): string | undefined {
  return isCanonicalUuidV4(value) ? value : undefined;
}

export { relayClaimEpoch } from './claim-transition.js';

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
  if (!authorization?.startsWith('Bearer ')) return false;
  // Compare digests: constant time, and a length mismatch never throws nor leaks the length.
  return timingSafeEqual(ticketSha256(authorization.slice(7)), ticketSha256(expected));
}

function counterValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export interface TerminalRelayProxyOptions {
  readonly pool: DatabasePool;
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly grants: GrantStore;
  readonly repository: AgentTargetRepository;
  readonly relayPeerInstanceId: ((request: FastifyRequest) => string | undefined) | undefined;
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
  readonly CLOSE_WITH_RECORDING_KEYS: typeof CLOSE_WITH_RECORDING_KEYS;
  readonly CLOSE_WITH_CLAIM_AND_RECORDING_KEYS: typeof CLOSE_WITH_CLAIM_AND_RECORDING_KEYS;
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
    pool, config, registry, grants, repository, replyError, recordTransactionalTerminalAudit,
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
    const expiry = sessionExpiry(row, config.sessionTtlSeconds, config.sessionMaxTotalSeconds)
      ?? row.expires_at;
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
      // Never log or audit the claim token; PostgreSQL keeps only its digest, and the relay spool is 0600.
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
      const visible = await repository.authorizeAgentTarget(
        actor.tenant_id, actor.alias, member.tenant_id, member.alias, 'control', database,
      );
      if (visible === undefined) return { allowed: false, reason: 'control_authority_revoked' };
    }
    const authority = await cohortRoutingAuthority(
      database ?? pool, actor.tenant_id, actor.alias, cohort,
    );
    if (!authority.allowed) return { allowed: false, reason: 'no_routing_authority' };
    const grantStore = freshGrants
      ? new GrantStore(config.grantsFile, (message) => { app.log.warn(message); })
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
    replyError,
    recordTransactionalTerminalAudit,
    PRESENCE_KEYS,
    CONSUME_KEYS,
    AUTHZ_KEYS,
    RESUME_KEYS,
    RESUME_WITH_EPOCH_KEYS,
    CLOSE_KEYS,
    CLOSE_WITH_CLAIM_KEYS,
    CLOSE_WITH_RECORDING_KEYS,
    CLOSE_WITH_CLAIM_AND_RECORDING_KEYS,
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

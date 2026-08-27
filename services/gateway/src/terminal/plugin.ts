import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CauceRepository, StoreError, type DatabaseClient, type DatabasePool,
  type AuthorizedAgentTarget,
} from '@cauce/store';
import { AliasSchema, TenantSchema, type Tenant } from '@cauce/protocol';
import {
  AuthError, AuthorizationError, requireOperatorPermission, validatePrincipal,
  type AuthProvider, type Principal
} from '../auth.js';
import {
  type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import {
  recordTerminalAudit, terminalAuditMetadata, type TerminalAuditContext, type TerminalAuditEntry,
} from './audit.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetIdentity,
  fleetIdentityLabel, fleetPlacement, loadFleetPlacements, resolveOperator, routingAuthority,
  type ResolvedOperator, type RoutingAuthority
} from './authority.js';
import type { TerminalConfig } from './config.js';
import { createGovernanceProbes } from './governance-probes.js';
import {
  AgentRegistry, RelayBootConflictError, parseAgentPresence,
  type AgentResolution, type RelayProcessIdentity,
} from './registry.js';
import {
  deriveAliasKey, issueResumeToken, issueTicket, ticketDigest, ticketSha256,
  verifyResumeTokenSignature, verifyTicketSignature,
  TicketError, type TicketPayload
} from './tickets.js';
import { isTerminalMode, type TerminalMode, type TerminalSessionRow, type TerminalTarget } from './types.js';

/**
 * PTY control plane. The gateway DECIDES and AUDITS; it never carries a byte of PTY.
 *
 * Topology this plugin has to live with: the gateway, the console and PostgreSQL run on
 * `agora-storage`, while the fourteen agent containers live on `kratos`. Every terminal
 * therefore crosses that host boundary, and it crosses it through terminal-relay — the only
 * component with a route into the containers. The browser talks to the relay over the
 * WebSocket path announced in the capability; the relay talks back here over
 * /v3/terminal/relay/* to redeem a ticket, revalidate it every few seconds and report closure.
 * Nothing in that path lets the browser name a container: it names `(tenant, alias)` and the
 * enabled PostgreSQL registry resolves placement.  The release gate separately proves that
 * registry matches the declarative operations inventory.
 *
 * Route placement is deliberate:
 *  - /v3/console/terminal/*  browser routes, covered by the global console security hook
 *    (Origin allowlist, Vary: Origin, Sec-Fetch-Site rejection) that app.ts registered first.
 *  - /v3/terminal/relay/*    relay routes, OUTSIDE /v3/console/ because that hook demands a
 *    same-origin Origin header on every non-GET and the relay is not a browser.
 */

const REASON_MIN = 8;
const REASON_MAX = 280;
const COLS_MIN = 20;
const COLS_MAX = 500;
const ROWS_MIN = 5;
const ROWS_MAX = 200;
const MAX_TERMINAL_CLOCK_SKEW_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const SESSION_REQUEST_KEYS = [
  'alias', 'cols', 'mode', 'owner_token', 'reason', 'request_id', 'rows', 'tenant_id',
] as const;
const OWNER_ROTATION_KEYS = [
  'expected_owner_generation', 'owner_token', 'request_id',
] as const;
const DELETE_SESSION_KEYS = ['owner_generation', 'owner_token', 'request_id'] as const;
const PRESENCE_KEYS = ['agents', 'relay_boot_id', 'relay_instance_id'] as const;
const CONSUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'ticket'] as const;
const AUTHZ_KEYS = ['claim_epoch', 'claim_token', 'relay_boot_id', 'relay_instance_id'] as const;
const RESUME_KEYS = ['claim_token', 'relay_boot_id', 'relay_instance_id', 'resume_token'] as const;
const RESUME_WITH_EPOCH_KEYS = [...RESUME_KEYS, 'claim_epoch'].sort();
const CLOSE_KEYS = ['bytes_in', 'bytes_out', 'exit_code', 'reason', 'relay_boot_id', 'relay_instance_id'] as const;
const CLOSE_WITH_CLAIM_KEYS = [...CLOSE_KEYS, 'claim_epoch', 'claim_token'].sort();

class TerminalClockSkewError extends Error {
  constructor() {
    super('terminal issuance clock is not synchronized with PostgreSQL');
    this.name = 'TerminalClockSkewError';
  }
}

export interface TerminalControlPlaneOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly config: TerminalConfig;
  /** Injectable for tests; production uses a fresh in-memory registry per process. */
  readonly registry?: AgentRegistry;
  readonly repository?: {
    assertPermission(tenantId: Tenant, alias: string, permission: 'control'): Promise<void>;
    authorizeAgentTarget(
      actorTenant: Tenant,
      actorAlias: string,
      targetTenant: Tenant,
      targetAlias: string,
      permission: 'read' | 'control',
    ): Promise<AuthorizedAgentTarget | undefined>;
  };
  /**
   * De dónde salen los hechos medidos de cada alias (arnés, HOME, CODEX_HOME) para resolver la
   * ruta de su manual del sitio.
   */
  readonly measuredFacts?: MeasuredFactsSource;
  /** Inyectable para los tests; en producción sale de `config.relayUrl`. */
  readonly governanceRelay?: GovernanceRelayClient;
  /** Test seam only. Production hashes the verified TLS peer leaf directly from the socket. */
  readonly relayPeerInstanceId?: (request: FastifyRequest) => string | undefined;
}

interface SessionRequestBody {
  tenant_id: string;
  alias: string;
  mode: TerminalMode;
  reason: string;
  cols: number;
  rows: number;
  request_id: string;
  owner_token: string;
}

interface OwnerRotationBody {
  request_id: string;
  expected_owner_generation: string;
  owner_token: string;
}

interface DeleteSessionBody {
  request_id: string;
  owner_generation: string;
  owner_token: string;
}

function replyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof TerminalClockSkewError) {
    void reply.code(503).send({
      error: 'terminal_clock_skew',
      message: 'terminal issuance is unavailable until gateway and PostgreSQL clocks agree'
    });
    return;
  }
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof StoreError) {
    void reply.code(error.code === 'not_found' ? 404 : 403).send({ error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  void reply.code(400).send({ error: 'invalid_request', message });
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function exactObjectKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

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

function terminalRelayWebsocketPath(relayInstanceId: string): string {
  if (!/^[0-9a-f]{64}$/.test(relayInstanceId)) throw new Error('database terminal relay instance id is invalid');
  return `/v3/console/terminal/relays/${relayInstanceId}/ws`;
}

function canonicalUuidV4(value: unknown, name: string): string {
  if (typeof value !== 'string' || !CLAIM_UUID_PATTERN.test(value) || value[14] !== '4') {
    throw new Error(`${name} must be a canonical UUIDv4`);
  }
  return value;
}

function relayClaimToken(value: unknown): string | undefined {
  return typeof value === 'string' && CLAIM_UUID_PATTERN.test(value) ? value : undefined;
}

/** Fence epochs stay decimal strings on the wire and in node-postgres; Number is never involved. */
function relayClaimEpoch(value: unknown): string | undefined {
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

function parseSessionRequest(value: unknown): SessionRequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session request must be an object');
  }
  const body = value as Record<string, unknown>;
  if (!exactObjectKeys(body, SESSION_REQUEST_KEYS)) {
    throw new Error('session request has unexpected or missing fields');
  }
  const tenant = TenantSchema.safeParse(body.tenant_id);
  if (!tenant.success) {
    throw new Error('tenant_id is required');
  }
  const alias = AliasSchema.safeParse(body.alias);
  if (!alias.success) {
    throw new Error('alias is invalid');
  }
  if (!isTerminalMode(body.mode)) throw new Error("mode must be 'shell' or 'harness'");
  // The operator reason is mandatory and hand written: it is the only human explanation the
  // audit row will ever carry, so it is never defaulted or auto-generated.
  if (typeof body.reason !== 'string' || body.reason.trim().length < REASON_MIN || body.reason.length > REASON_MAX) {
    throw new Error(`reason must be between ${REASON_MIN} and ${REASON_MAX} characters`);
  }
  return {
    tenant_id: tenant.data,
    alias: alias.data,
    mode: body.mode,
    reason: body.reason.trim(),
    cols: boundedInteger(body.cols, COLS_MIN, COLS_MAX, 'cols'),
    rows: boundedInteger(body.rows, ROWS_MIN, ROWS_MAX, 'rows'),
    request_id: canonicalUuidV4(body.request_id, 'request_id'),
    owner_token: canonicalUuidV4(body.owner_token, 'owner_token'),
  };
}

function parseOwnerRotation(value: unknown): OwnerRotationBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('owner rotation request must be an object');
  }
  const body = value as Record<string, unknown>;
  if (!exactObjectKeys(body, OWNER_ROTATION_KEYS)) {
    throw new Error('owner rotation request has unexpected or missing fields');
  }
  const generation = relayClaimEpoch(body.expected_owner_generation);
  if (generation === undefined) throw new Error('expected_owner_generation is invalid');
  return {
    request_id: canonicalUuidV4(body.request_id, 'request_id'),
    expected_owner_generation: generation,
    owner_token: canonicalUuidV4(body.owner_token, 'owner_token'),
  };
}

function parseDeleteSession(value: unknown): DeleteSessionBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('terminal session release must be an object');
  }
  const body = value as Record<string, unknown>;
  if (!exactObjectKeys(body, DELETE_SESSION_KEYS)) {
    throw new Error('terminal session release has unexpected or missing fields');
  }
  const generation = relayClaimEpoch(body.owner_generation);
  if (generation === undefined) throw new Error('owner_generation is invalid');
  return {
    request_id: canonicalUuidV4(body.request_id, 'request_id'),
    owner_generation: generation,
    owner_token: canonicalUuidV4(body.owner_token, 'owner_token'),
  };
}

function relayAuthorized(request: FastifyRequest, expected: string): boolean {
  const header: unknown = request.headers.authorization;
  const authorization = typeof header === 'string' ? header : undefined;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  // Compare digests: constant time, and a length mismatch never throws nor leaks the length.
  return timingSafeEqual(ticketSha256(authorization.slice(7)), ticketSha256(expected));
}

function sessionState(row: TerminalSessionRow, occupiesSlot: boolean): 'issued' | 'active' | 'closed' {
  // `occupiesSlot` is calculated by PostgreSQL with the exact admission predicate and DB clock.
  // A browser clock must never decide that a server-side slot does or does not exist.
  if (!occupiesSlot) return 'closed';
  return row.consumed_at === null ? 'issued' : 'active';
}

function counterValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function subjectFor(actor: Pick<Principal, 'tenant_id' | 'alias'>): string {
  return `${actor.tenant_id}:${actor.alias}`;
}

function terminalAdmissionRequestSha256(input: {
  body: SessionRequestBody;
  actor: Pick<Principal, 'tenant_id' | 'alias'>;
  operator: Pick<ResolvedOperator, 'operator_id' | 'attributed'>;
  consoleSubject: string;
  container: string;
  presenceGeneration: string;
  imageId: string;
  runtimeUser: string;
  runtimeUid: number;
  relayInstanceId: string;
}): Buffer {
  // Fixed construction, not caller JSON: identity and placement are server-derived and the owner
  // token is deliberately absent. That token has its own digest and may only change through the
  // explicit ownership endpoint.
  const material = {
    suite: 'cauce-v3-terminal-browser-admission',
    version: 1,
    request_id: input.body.request_id,
    actor: { tenant_id: input.actor.tenant_id, alias: input.actor.alias },
    operator: {
      operator_id: input.operator.operator_id,
      attributed: input.operator.attributed,
      console_subject: input.consoleSubject,
    },
    target: {
      tenant_id: input.body.tenant_id,
      alias: input.body.alias,
      container: input.container,
      presence_generation: input.presenceGeneration,
      image_id: input.imageId,
      runtime_user: input.runtimeUser,
      runtime_uid: input.runtimeUid,
      mode: input.body.mode,
      relay_instance_id: input.relayInstanceId,
    },
    reason: input.body.reason,
    cols: input.body.cols,
    rows: input.body.rows,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest();
}

function ticketTtlSeconds(row: Pick<TerminalSessionRow, 'issued_at' | 'expires_at'>): number {
  const milliseconds = row.expires_at.getTime() - row.issued_at.getTime();
  const seconds = milliseconds / 1_000;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) {
    throw new Error('database terminal ticket TTL is invalid');
  }
  return seconds;
}

function browserOwnerGeneration(value: string): string {
  const generation = relayClaimEpoch(value);
  if (generation === undefined) throw new Error('database browser owner generation is invalid');
  return generation;
}

/**
 * The legacy pseudo-operator is shared by every basic-auth console session. It is not an
 * identity, so its quota/list/revoke namespace must additionally include the authenticated
 * certificate subject. Named operators remain intentionally shared across their own sessions.
 */
function operatorLockIdentity(operator: ResolvedOperator, consoleSubject: string): string {
  return operator.attributed
    ? operator.operator_id
    : JSON.stringify([operator.operator_id, consoleSubject]);
}

function operatorScopePredicate(
  operatorParameter: number,
  attributedParameter: number,
  subjectParameter: number,
): string {
  return `operator_id=$${operatorParameter}
          AND ($${attributedParameter}::boolean OR console_subject=$${subjectParameter})`;
}

/** Audit writes which guard a state transition use the same PostgreSQL transaction. */
async function recordTransactionalTerminalAudit(
  client: DatabaseClient,
  entry: TerminalAuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(tenant_id, actor_alias, action, decision, trace_id, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      entry.tenant_id,
      entry.actor_alias,
      entry.action,
      entry.decision,
      entry.trace_id ?? null,
      JSON.stringify(entry.metadata),
    ],
  );
}

/**
 * Authority and reachability are independent. An authorized destination can still be offline,
 * not installed or unknown, so its reason must describe the measured PTY state rather than the
 * authority decision that allowed the row to be disclosed.
 */
function terminalTargetStateReason(resolution: AgentResolution, container: string): string {
  switch (resolution.status) {
    case 'online':
      return 'El agente PTY está conectado al terminal-relay.';
    case 'offline':
      return 'El agente PTY figura fuera de línea: no está conectado al terminal-relay.';
    case 'ambiguous':
      return 'El agente PTY figura fuera de línea porque más de un terminal-relay lo anuncia y no hay una ruta única segura.';
    case 'not_installed':
      return `El agente PTY figura como no instalado: el terminal-relay nunca registró este destino en ${container}.`;
    case 'unknown':
      return 'El estado del agente PTY es desconocido: el terminal-relay todavía no publicó un snapshot verificable.';
  }
}

export async function registerTerminalControlPlane(
  app: FastifyInstance,
  options: TerminalControlPlaneOptions
): Promise<void> {
  const { pool, authProvider, config } = options;
  const registry = options.registry ?? new AgentRegistry();
  const grants = new GrantStore(config.grantsFile, (message) => app.log.warn(message));
  const repository = options.repository ?? new CauceRepository(pool);
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

  async function principal(request: FastifyRequest): Promise<Principal> {
    return validatePrincipal(await authProvider.authenticateHttp(request));
  }

  /** Open = neither closed nor revoked, and still inside its ticket or session window. */
  function openPredicate(ttlParameter: number): string {
    return `closed_at IS NULL AND revoked_at IS NULL
            AND ((consumed_at IS NULL AND expires_at > now())
                 OR (consumed_at IS NOT NULL AND consumed_at + make_interval(secs => $${ttlParameter}) > now()))`;
  }

  async function currentCohort(
    tenantId: string,
    alias: string,
    database: DatabasePool | DatabaseClient = pool,
  ) {
    const placements = await loadFleetPlacements(database);
    return containerCohort(placements, tenantId, alias);
  }

  function cohortLabels(cohort: Awaited<ReturnType<typeof currentCohort>>): string[] {
    return cohort.map(fleetIdentityLabel);
  }

  function sessionExpiry(row: TerminalSessionRow): Date | undefined {
    if (row.consumed_at === null) return undefined;
    return new Date(row.consumed_at.getTime() + config.sessionTtlSeconds * 1_000);
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
      // Never persisted or logged. It only crosses the relay mTLS path and then the already
      // authenticated browser WebSocket as part of `ready`.
      resume_token: resumeToken
    };
  }

  interface CurrentSessionPolicy {
    readonly allowed: boolean;
    readonly reason: string;
    readonly actor_tenant?: string;
    readonly actor_alias?: string;
    readonly cohort?: Awaited<ReturnType<typeof currentCohort>>;
    readonly source_room_ids?: readonly string[];
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
    if (placement === undefined || placement.container !== row.container) {
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

  /* ------------------------------------------------------------------ */
  /* Browser routes: /v3/console/terminal                                */
  /* ------------------------------------------------------------------ */

  app.get('/v3/console/terminal/targets', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const now = Date.now();
      const placements = await loadFleetPlacements(pool);
      // One routing decision per (tenant, alias) even though cohorts overlap heavily.
      const decisions = new Map<string, Promise<RoutingAuthority>>();
      const authorityFor = (tenantId: string, alias: string): Promise<RoutingAuthority> => {
        const cacheKey = `${tenantId}\0${alias}`;
        let pending = decisions.get(cacheKey);
        if (!pending) {
          pending = routingAuthority(pool, actor.tenant_id, actor.alias, tenantId, alias);
          decisions.set(cacheKey, pending);
        }
        return pending;
      };
      const visibilityDecisions = new Map<string, Promise<boolean>>();
      const visibleFor = (tenantId: string, alias: string): Promise<boolean> => {
        const cacheKey = `${tenantId}\0${alias}`;
        let pending = visibilityDecisions.get(cacheKey);
        if (!pending) {
          pending = repository.authorizeAgentTarget(
            actor.tenant_id, actor.alias, tenantId, alias, 'control',
          ).then((target) => target !== undefined);
          visibilityDecisions.set(cacheKey, pending);
        }
        return pending;
      };
      const items: TerminalTarget[] = [];
      for (const placement of placements) {
        // La tabla `agents` contiene toda la flota física, no sólo la visible para este actor.
        // Enumerarla antes de autorizar filtraba nombres, tenants y cohortes de clientes sin una
        // arista allow_control. La misma identidad canónica que gobierna el resto de la consola
        // decide primero si la fila puede existir en esta respuesta.
        if (!(await visibleFor(placement.tenant_id, placement.alias))) continue;
        const cohort = containerCohort(placements, placement.tenant_id, placement.alias);
        // A shared container is one authority surface. Never reveal the names of hidden colocated
        // tenants merely because the requested placement itself is visible.
        const cohortVisible = (await Promise.all(
          cohort.map((member) => visibleFor(member.tenant_id, member.alias))
        )).every(Boolean);
        const resolution = registry.resolve(placement.tenant_id, placement.alias, now);
        const observation = resolution.status === 'online' || resolution.status === 'offline'
          ? resolution.observation
          : undefined;
        const state = registry.state(placement.tenant_id, placement.alias, now);
        let authorized = cohortVisible
          && attributionAllows(operator.attributed, actor.tenant_id, placement.tenant_id);
        for (const member of cohort) {
          if (!authorized) break;
          if (!attributionAllows(operator.attributed, actor.tenant_id, member.tenant_id)) {
            authorized = false;
            break;
          }
          authorized = (await authorityFor(member.tenant_id, member.alias)).allowed;
        }
        const reported = observation?.presence.modes ?? ['shell'];
        const modes: string[] = [];
        if (authorized) {
          for (const mode of reported) {
            if (!isTerminalMode(mode)) continue;
            if (await grants.allowsCohort(operator.operator_id, cohort, mode, now)) modes.push(mode);
          }
        }
        const usable = authorized && modes.length > 0;
        items.push({
          tenant_id: placement.tenant_id,
          alias: placement.alias,
          // Denial must not confirm what the target looks like, only that authority is missing.
          container: usable ? placement.container : null,
          runtime_user: usable ? (observation?.presence.runtime_user ?? placement.runtime_user) : null,
          harness: usable ? (observation?.presence.harness ?? null) : null,
          image: usable ? (observation?.presence.image_id ?? null) : null,
          shares_container_with: cohortVisible
            ? cohort
              .filter((member) => member.tenant_id !== placement.tenant_id || member.alias !== placement.alias)
              .map(fleetIdentity)
            : [],
          modes: usable ? modes : [],
          pty_state: state,
          last_seen: observation?.observed_at ?? null,
          authorized: usable,
          reason: usable
            ? terminalTargetStateReason(resolution, placement.container)
            : `sin autoridad sobre ${placement.tenant_id}:${placement.alias}`
        });
      }
      return {
        observed_at: new Date(now).toISOString(),
        websocket_path: config.wsPath,
        items
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post('/v3/console/terminal/sessions', async (request, reply) => {
    const traceId = `trace-${randomUUID()}`;
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const body = parseSessionRequest(request.body);
      const consoleSubject = subjectFor(actor);
      const redactedAudit: TerminalAuditContext = {
        operator_id: operator.operator_id,
        attributed: operator.attributed,
        target_tenant: body.tenant_id,
        target_alias: body.alias,
        container: null,
        cohort: [],
        mode: body.mode,
      };
      const denyRedacted = async (
        status: 403 | 404,
        reason: string,
      ): Promise<void> => {
        await recordTerminalAudit(pool, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.request',
          decision: 'deny',
          trace_id: traceId,
          metadata: terminalAuditMetadata(redactedAudit, {
            reason,
            operator_reason: body.reason,
          }),
        });
        await reply.code(status).send(status === 404
          ? { error: 'not_found' }
          : { error: 'forbidden', reason });
      };

      // Canonical actor permission and target visibility run before the fleet table is expanded.
      // Missing and hidden targets therefore have one response and an audit row with no placement
      // or cohort metadata supplied by the server.
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await denyRedacted(403, 'control_permission_required');
        return;
      }
      const canonicalTarget = await repository.authorizeAgentTarget(
        actor.tenant_id, actor.alias, body.tenant_id, body.alias, 'control',
      );
      if (canonicalTarget === undefined) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const placements = await loadFleetPlacements(pool);
      const placement = fleetPlacement(placements, canonicalTarget.tenant_id, canonicalTarget.alias);
      if (placement === undefined) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const cohort = containerCohort(placements, placement.tenant_id, placement.alias);
      const cohortVisible = (await Promise.all(cohort.map(async (member) =>
        (await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, member.tenant_id, member.alias, 'control',
        )) !== undefined
      ))).every(Boolean);
      if (!cohortVisible) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const audit: TerminalAuditContext = {
        ...redactedAudit,
        target_tenant: placement.tenant_id,
        target_alias: placement.alias,
        container: placement.container,
        cohort: cohortLabels(cohort),
      };
      const deny = async (
        status: 403 | 409,
        reason: string,
        extra: Record<string, unknown> = {},
      ): Promise<void> => {
        await recordTerminalAudit(pool, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.request',
          decision: 'deny',
          trace_id: traceId,
          metadata: terminalAuditMetadata(audit, {
            reason,
            operator_reason: body.reason,
            ...extra,
          }),
        });
        await reply.code(status).send(
          status === 403 ? { error: 'forbidden', reason } : { error: 'conflict', reason },
        );
      };

      if (!attributionAllows(operator.attributed, actor.tenant_id, placement.tenant_id)) {
        await deny(403, 'attribution_required');
        return;
      }
      for (const member of cohort) {
        if (!attributionAllows(operator.attributed, actor.tenant_id, member.tenant_id)) {
          await deny(403, 'attribution_required');
          return;
        }
      }
      // Gate 4: routing authority over EVERY alias sharing the container.
      const authority = await cohortRoutingAuthority(pool, actor.tenant_id, actor.alias, cohort);
      if (!authority.allowed) {
        await deny(403, 'no_routing_authority', { authority_reason: authority.reason });
        return;
      }
      // Gate 5: grants file, re-read from disk, over the whole cohort.
      if (!(await grants.allowsCohort(operator.operator_id, cohort, body.mode))) {
        await deny(403, 'no_grant');
        return;
      }
      // Gate 6: a live pty-agent inside the target container.
      const resolution = registry.resolve(placement.tenant_id, body.alias);
      if (resolution.status !== 'online' || !resolution.observation.presence.modes.includes(body.mode)) {
        await deny(409, 'agent_offline', {
          pty_state: registry.state(placement.tenant_id, body.alias),
          ...(resolution.status === 'ambiguous' ? { routing_state: 'relay_ambiguous' } : {}),
        });
        return;
      }
      const observation = resolution.observation;
      const requestSha256 = terminalAdmissionRequestSha256({
        body,
        actor,
        operator,
        consoleSubject,
        container: observation.presence.container_id,
        presenceGeneration: observation.presence.generation,
        imageId: observation.presence.image_id,
        runtimeUser: observation.presence.runtime_user,
        runtimeUid: observation.presence.runtime_uid,
        relayInstanceId: observation.relay_instance_id,
      });
      const browserOwnerSha256 = ticketSha256(body.owner_token);
      const sessionId = randomUUID();
      const admissionClient = await pool.connect();
      let transactionOpen = false;
      let conflict: 'session_limit' | 'container_busy' | 'request_conflict' | undefined;
      let receipt: { row: TerminalSessionRow; ticket: string; recovered: boolean } | undefined;
      try {
        await admissionClient.query('BEGIN');
        transactionOpen = true;
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:operator:' || $1, 0))`,
          [operatorLockIdentity(operator, consoleSubject)],
        );
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:container:' || $1, 0))`,
          [observation.presence.container_id],
        );
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:request:' || $1, 0))`,
          [body.request_id],
        );

        // A retry after a lost HTTP 201 is identified by request_id, never by coincidentally equal
        // UI fields. Both semantic and owner digests must match. A new logical tab necessarily has
        // another request id, so it can neither adopt nor later revoke this row.
        const recoverable = await admissionClient.query<TerminalSessionRow & { request_unexpired: boolean }>(
          `SELECT terminal_sessions.*,expires_at>now() AS request_unexpired
             FROM terminal_sessions WHERE request_id=$1 FOR UPDATE`,
          [body.request_id],
        );
        const previous = recoverable.rows[0];
        if (previous !== undefined) conflict = 'request_conflict';
        const exactPrevious = previous !== undefined
            && previous.operator_id === operator.operator_id
            && (operator.attributed || previous.console_subject === consoleSubject)
            && previous.console_subject === consoleSubject
            && previous.tenant_id === placement.tenant_id
            && previous.alias === body.alias
            && previous.container === observation.presence.container_id
            && previous.relay_instance_id === observation.relay_instance_id
            && previous.mode === body.mode
            && previous.reason === body.reason
            && previous.cols === body.cols
            && previous.rows === body.rows
            && previous.request_sha256.equals(requestSha256)
            && previous.browser_owner_sha256.equals(browserOwnerSha256)
            && previous.consumed_at === null
            && previous.revoked_at === null
            && previous.closed_at === null
            && previous.request_unexpired;
        if (exactPrevious
            && previous.generation === observation.presence.generation
            && previous.image_id === observation.presence.image_id
            && previous.runtime_user === observation.presence.runtime_user
            && previous.container === observation.presence.container_id) {
          const rebuilt = issueTicket({
            v: 1,
            sid: previous.id,
            op: previous.operator_id,
            sub: previous.console_subject,
            tgt: {
              tenant: previous.tenant_id,
              alias: previous.alias,
              container: previous.container,
              generation: previous.generation,
              image: previous.image_id,
              uid: observation.presence.runtime_uid,
              user: previous.runtime_user,
            },
            mode: previous.mode,
            iat: Math.floor(previous.issued_at.getTime() / 1_000),
            exp: Math.floor(previous.expires_at.getTime() / 1_000),
          }, deriveAliasKey(config.ticketKey, previous.tenant_id, previous.alias));
          if (ticketSha256(rebuilt).equals(previous.ticket_sha256)) {
            await recordTransactionalTerminalAudit(admissionClient, {
              tenant_id: actor.tenant_id,
              actor_alias: actor.alias,
              action: 'terminal.session.request',
              decision: 'allow',
              ...(previous.trace_id === null ? {} : { trace_id: previous.trace_id }),
              metadata: terminalAuditMetadata(audit, {
                session_id: previous.id,
                operator_reason: previous.reason,
                ticket_sha256: ticketDigest(rebuilt),
                receipt_recovered: true,
                source_room_ids: authority.source_room_ids,
              }),
            });
            receipt = { row: previous, ticket: rebuilt, recovered: true };
          }
        }

        if (receipt === undefined && previous === undefined) {
        const localBeforeClockQuery = Date.now();
        const clock = await admissionClient.query<{ database_now: Date }>(
          'SELECT clock_timestamp() AS database_now',
        );
        const localAfterClockQuery = Date.now();
        const issuedAt = clock.rows[0]?.database_now;
        if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
          throw new Error('database returned an invalid terminal admission timestamp');
        }
        if (issuedAt.getTime() < localBeforeClockQuery - MAX_TERMINAL_CLOCK_SKEW_MS
            || issuedAt.getTime() > localAfterClockQuery + MAX_TERMINAL_CLOCK_SKEW_MS) {
          throw new TerminalClockSkewError();
        }
        const expiresAt = new Date(issuedAt.getTime() + config.ticketTtlSeconds * 1_000);
        const payload: TicketPayload = {
          v: 1,
          sid: sessionId,
          op: operator.operator_id,
          sub: consoleSubject,
          tgt: {
            tenant: placement.tenant_id,
            alias: body.alias,
            container: observation.presence.container_id,
            generation: observation.presence.generation,
            image: observation.presence.image_id,
            uid: observation.presence.runtime_uid,
            user: observation.presence.runtime_user
          },
          mode: body.mode,
          iat: Math.floor(issuedAt.getTime() / 1_000),
          exp: Math.floor(expiresAt.getTime() / 1_000)
        };
        const ticket = issueTicket(
          payload,
          deriveAliasKey(config.ticketKey, placement.tenant_id, body.alias),
        );
        const admitted = await admissionClient.query<{
          reason: 'ok' | 'session_limit' | 'container_busy'; id: string | null;
        }>(
          `WITH decision AS MATERIALIZED (
           SELECT CASE
             WHEN (SELECT count(*) FROM terminal_sessions
                    WHERE ${operatorScopePredicate(1, 6, 7)}
                      AND ${openPredicate(3)}) >= $4 THEN 'session_limit'
             WHEN EXISTS (SELECT 1 FROM terminal_sessions
                    WHERE container=$2 AND ${openPredicate(3)}) THEN 'container_busy'
             ELSE 'ok'
           END AS reason
         ), inserted AS (
           INSERT INTO terminal_sessions(
             id, operator_id, attributed, console_subject, tenant_id, alias, container, generation,
             image_id, runtime_user, mode, ticket_sha256, reason, cols, rows, trace_id,
             issued_at, expires_at, request_id, request_sha256, browser_owner_sha256,
             browser_owner_generation, relay_instance_id, relay_boot_id
           )
           SELECT $5,$1,$6,$7,$8,$9,$2,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,1,$24,NULL
             FROM decision WHERE reason='ok'
           RETURNING id
         )
         SELECT decision.reason, inserted.id
           FROM decision LEFT JOIN inserted ON true`,
          [
            operator.operator_id, observation.presence.container_id, config.sessionTtlSeconds,
            config.maxSessionsPerOperator, sessionId, operator.attributed,
            consoleSubject, placement.tenant_id, body.alias,
            observation.presence.generation, observation.presence.image_id,
            observation.presence.runtime_user, body.mode, ticketSha256(ticket), body.reason,
            body.cols, body.rows, traceId, issuedAt.toISOString(), expiresAt.toISOString(),
            body.request_id, requestSha256, browserOwnerSha256,
            observation.relay_instance_id,
          ]
        );
        const admission = admitted.rows[0];
        if (admission?.reason === 'ok' && admission.id === sessionId) {
          const inserted = await admissionClient.query<TerminalSessionRow>(
            'SELECT * FROM terminal_sessions WHERE id=$1 FOR UPDATE',
            [sessionId],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error('terminal admission lost its inserted receipt');
          await recordTransactionalTerminalAudit(admissionClient, {
            tenant_id: actor.tenant_id,
            actor_alias: actor.alias,
            action: 'terminal.session.request',
            decision: 'allow',
            trace_id: traceId,
            metadata: terminalAuditMetadata(audit, {
              session_id: sessionId,
              image_id: observation.presence.image_id,
              generation: observation.presence.generation,
              runtime_user: observation.presence.runtime_user,
              operator_reason: body.reason,
              cols: body.cols,
              rows: body.rows,
              ticket_sha256: ticketDigest(ticket),
              receipt_recovered: false,
              source_room_ids: authority.source_room_ids,
            }),
          });
          receipt = { row, ticket, recovered: false };
        } else {
          conflict = admission?.reason === 'session_limit' ? 'session_limit' : 'container_busy';
        }
        }
        await admissionClient.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await admissionClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        admissionClient.release();
      }
      if (receipt === undefined) {
        await deny(409, conflict ?? 'container_busy');
        return;
      }
      return await reply.code(201).send({
        session_id: receipt.row.id,
        ticket: receipt.ticket,
        websocket_path: terminalRelayWebsocketPath(receipt.row.relay_instance_id),
        expires_at: receipt.row.expires_at.toISOString(),
        ttl_seconds: ticketTtlSeconds(receipt.row),
        receipt_recovered: receipt.recovered,
        request_id: receipt.row.request_id,
        owner_generation: browserOwnerGeneration(receipt.row.browser_owner_generation),
        target: {
          tenant_id: placement.tenant_id,
          alias: body.alias,
          container: observation.presence.container_id,
          runtime_user: observation.presence.runtime_user,
          mode: body.mode,
          shares_container_with: cohort
            .filter((member) => member.tenant_id !== body.tenant_id || member.alias !== body.alias)
            .map(fleetIdentity)
        }
      });
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/terminal/sessions', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      const result = await pool.query<TerminalSessionRow & { occupies_slot: boolean }>(
        // The endpoint is the operator's escape hatch for slots that remain open after a tab
        // disappears. History can be arbitrarily large; sorting only by issued_at allowed 100
        // newer closed rows to push a still-open session out of the bounded response. Open rows
        // therefore come first, using the exact same predicate as admission.
        `SELECT terminal_sessions.*, (${openPredicate(2)}) AS occupies_slot
           FROM terminal_sessions
          WHERE ${operatorScopePredicate(1, 3, 4)}
          ORDER BY occupies_slot DESC, issued_at DESC
          LIMIT 100`,
        [operator.operator_id, config.sessionTtlSeconds, operator.attributed, consoleSubject]
      );
      return {
        items: result.rows.map((row) => ({
          session_id: row.id,
          tenant_id: row.tenant_id,
          alias: row.alias,
          mode: row.mode,
          opened_at: row.issued_at.toISOString(),
          expires_at: (sessionExpiry(row) ?? row.expires_at).toISOString(),
          state: sessionState(row, row.occupies_slot === true),
          request_id: row.request_id,
          owner_generation: browserOwnerGeneration(row.browser_owner_generation),
        }))
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid/owner', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseOwnerRotation(request.body);
      const ownerClient = await pool.connect();
      let ownerTransactionOpen = false;
      let row: TerminalSessionRow | undefined;
      try {
        await ownerClient.query('BEGIN');
        ownerTransactionOpen = true;
        const rotated = await ownerClient.query<TerminalSessionRow>(
          `UPDATE terminal_sessions
              SET browser_owner_sha256=$4,
                  browser_owner_generation=browser_owner_generation+1
            WHERE id=$1 AND request_id=$2 AND browser_owner_generation=$3::bigint
              AND ${operatorScopePredicate(5, 6, 7)}
              AND browser_owner_generation<9223372036854775807
              AND revoked_at IS NULL AND closed_at IS NULL
            RETURNING *`,
          [
            request.params.sid,
            body.request_id,
            body.expected_owner_generation,
            ticketSha256(body.owner_token),
            operator.operator_id,
            operator.attributed,
            consoleSubject,
          ],
        );
        row = rotated.rows[0];
        if (row === undefined) {
          await ownerClient.query('ROLLBACK');
          ownerTransactionOpen = false;
        } else {
          await recordTransactionalTerminalAudit(ownerClient, {
            tenant_id: actor.tenant_id,
            actor_alias: actor.alias,
            action: 'terminal.session.owner_rotated',
            decision: 'info',
            ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
            metadata: terminalAuditMetadata({
              operator_id: row.operator_id,
              attributed: row.attributed,
              target_tenant: row.tenant_id,
              target_alias: row.alias,
              container: row.container,
              cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias, ownerClient)),
              mode: row.mode,
            }, {
              session_id: row.id,
              request_id: row.request_id,
              owner_generation: row.browser_owner_generation,
              reason: 'operator_owner_takeover',
            }),
          });
          await ownerClient.query('COMMIT');
          ownerTransactionOpen = false;
        }
      } catch (error) {
        if (ownerTransactionOpen) await ownerClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        ownerClient.release();
      }
      if (row === undefined) {
        await reply.code(409).send({ error: 'conflict', reason: 'stale_terminal_owner' });
        return;
      }
      return {
        session_id: row.id,
        request_id: row.request_id,
        owner_generation: browserOwnerGeneration(row.browser_owner_generation),
      };
    } catch (error) { replyError(reply, error); }
  });

  app.delete<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseDeleteSession(request.body);
      // Revocation is a flag, not a socket kill: terminal-relay revalidates every few seconds
      // and closes the WebSocket with 4403 once /authz stops answering ok.
      const releaseClient = await pool.connect();
      let releaseTransactionOpen = false;
      let row: TerminalSessionRow | undefined;
      let settled = false;
      try {
        await releaseClient.query('BEGIN');
        releaseTransactionOpen = true;
        const revoked = await releaseClient.query<TerminalSessionRow>(
          `UPDATE terminal_sessions SET revoked_at=now()
            WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
              AND request_id=$5
              AND browser_owner_generation=$6::bigint
              AND browser_owner_sha256=$7
              AND revoked_at IS NULL AND closed_at IS NULL RETURNING *`,
          [
            request.params.sid,
            operator.operator_id,
            operator.attributed,
            consoleSubject,
            body.request_id,
            body.owner_generation,
            ticketSha256(body.owner_token),
          ]
        );
        row = revoked.rows[0];
        if (row === undefined) {
          // A lost 204 is safe to retry with the exact same owner. A stale owner, another subject
          // or a different request all receive the same conflict and can mutate nothing.
          const existing = await releaseClient.query<{ settled: boolean }>(
            `SELECT EXISTS(
               SELECT 1 FROM terminal_sessions
                WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
                  AND request_id=$5 AND browser_owner_generation=$6::bigint
                  AND browser_owner_sha256=$7 AND (revoked_at IS NOT NULL OR closed_at IS NOT NULL)
             ) AS settled`,
            [
              request.params.sid,
              operator.operator_id,
              operator.attributed,
              consoleSubject,
              body.request_id,
              body.owner_generation,
              ticketSha256(body.owner_token),
            ],
          );
          settled = existing.rows[0]?.settled === true;
        } else {
          await recordTransactionalTerminalAudit(releaseClient, {
            tenant_id: actor.tenant_id,
            actor_alias: actor.alias,
            action: 'terminal.session.revoked',
            decision: 'info',
            ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
            metadata: terminalAuditMetadata({
              operator_id: row.operator_id,
              attributed: row.attributed,
              target_tenant: row.tenant_id,
              target_alias: row.alias,
              container: row.container,
              cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias, releaseClient)),
              mode: row.mode
            }, {
              session_id: row.id,
              request_id: row.request_id,
              owner_generation: row.browser_owner_generation,
              reason: 'operator_revoked',
            })
          });
        }
        if (row === undefined && !settled) {
          await releaseClient.query('ROLLBACK');
          releaseTransactionOpen = false;
        } else {
          await releaseClient.query('COMMIT');
          releaseTransactionOpen = false;
        }
      } catch (error) {
        if (releaseTransactionOpen) await releaseClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        releaseClient.release();
      }
      if (row === undefined && !settled) {
        await reply.code(409).send({ error: 'conflict', reason: 'stale_terminal_owner' });
        return;
      }
      return await reply.code(204).send();
    } catch (error) { replyError(reply, error); }
  });

  /* ------------------------------------------------------------------ */
  /* Browser route: la DIRECTIVA de un alias                             */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /v3/console/agents/:tenant/:alias/directive` vive aquí, y no en app.ts, porque su
   * contenido sólo existe cuando existe el plano de terminal: el texto sale del pty-agent y viaja
   * por el terminal-relay. Con `CAUCE_TERMINAL_ENABLED` apagado no hay por dónde leer nada, y una
   * ruta que sólo sabría contestar «no disponible» es peor que una ruta que no está.
   *
   * Al colgar de `/v3/console/` hereda el gancho de seguridad de consola (Origin, Sec-Fetch-Site)
   * que app.ts instala ANTES de este plugin, igual que el resto de rutas de navegador.
   */
  const governanceProbes = createGovernanceProbes(app, {
    config,
    registry,
    repository,
    runtimeOptions: options,
    principal,
    replyError,
  });
  const relayGovernance = options.governanceRelay ?? await governanceProbes.buildRelay();
  await governanceProbes.register(relayGovernance);

  /* ------------------------------------------------------------------ */
  /* Relay routes: /v3/terminal/relay                                    */
  /* ------------------------------------------------------------------ */

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (path?.startsWith('/v3/terminal/relay/') !== true) return;
    if (!relayAuthorized(request, config.relayToken)) {
      // No informative body: an unauthenticated caller learns nothing about the plane.
      await reply.code(401).send();
    }
  });

  app.post('/v3/terminal/relay/agents', async (request, reply) => {
    try {
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      if (!exactObjectKeys(record, PRESENCE_KEYS)) throw new Error('relay presence has unexpected or missing fields');
      const identity = requestRelayIdentity(request, record, false);
      if (identity === undefined) return await reply.code(401).send();
      const agents = record.agents;
      if (!Array.isArray(agents)) throw new Error('agents must be an array');
      try {
        registry.observe(identity, agents.map(parseAgentPresence));
      } catch (error) {
        if (error instanceof RelayBootConflictError) {
          return await reply.code(409).send({ ok: false, reason: 'relay_boot_conflict' });
        }
        throw error;
      }
      return {
        ok: true,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/consume', async (request, reply) => {
    const sid = request.params.sid;
    const invalid = async (): Promise<void> => {
      await reply.code(401).send({ ok: false, reason: 'ticket_invalid' });
    };
    try {
      if (!UUID_PATTERN.test(sid)) { await invalid(); return; }
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined || !exactObjectKeys(record, CONSUME_KEYS)) { await invalid(); return; }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const ticket = record?.ticket;
      const claimToken = relayClaimToken(record?.claim_token);
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4_096
          || claimToken === undefined) { await invalid(); return; }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedSession extends TerminalSessionRow {
        ticket_redeemable: boolean;
        session_recoverable: boolean;
        database_now: Date;
      }
      interface ClaimedSession extends TerminalSessionRow { database_now: Date }
      const client = await pool.connect();
      let transactionOpen = false;
      let session: TerminalSessionRow | undefined;
      let databaseNow: Date | undefined;
      let recovered = false;
      let takenOver = false;
      let refusal: { status: 401 | 403 | 409; reason: string; retry_after_ms?: number } | undefined;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<LockedSession>(
          `SELECT terminal_sessions.*,
                  consumed_at IS NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND expires_at > now() AS ticket_redeemable,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND consumed_at + make_interval(secs => $2) > now() AS session_recoverable,
                  now() AS database_now
             FROM terminal_sessions
            WHERE id=$1
            FOR UPDATE`,
          [sid, config.sessionTtlSeconds],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          refusal = { status: 401, reason: 'ticket_invalid' };
        } else {
          let payload: TicketPayload | undefined;
          try {
            payload = verifyTicketSignature(
              ticket,
              deriveAliasKey(config.ticketKey, row.tenant_id, row.alias),
            );
          } catch (error) {
            if (!(error instanceof TicketError)) throw error;
          }
          if (payload === undefined || payload.sid !== sid
              || payload.iat !== Math.floor(row.issued_at.getTime() / 1_000)
              || payload.exp !== Math.floor(row.expires_at.getTime() / 1_000)
              || !ticketSha256(ticket).equals(row.ticket_sha256)) {
            refusal = { status: 401, reason: 'ticket_invalid' };
          } else if (row.consumed_at === null && row.relay_instance_id !== identity.relay_instance_id) {
            refusal = { status: 403, reason: 'relay_fenced' };
          } else if (!row.ticket_redeemable && !row.session_recoverable) {
            refusal = { status: 401, reason: 'ticket_invalid' };
          } else {
            // This is a synchronous re-check immediately before the state transition/grant. It
            // includes canonical target visibility, the whole current container cohort, ACL and
            // routing authority, attribution, and a cache-free grants-file read.
            const policy = await currentSessionPolicy(row, true, client);
            const actor = sessionActor(row);
            const context: TerminalAuditContext = {
              operator_id: row.operator_id,
              attributed: row.attributed,
              target_tenant: row.tenant_id,
              target_alias: row.alias,
              container: row.container,
              cohort: policy.cohort === undefined ? [] : cohortLabels(policy.cohort),
              mode: row.mode,
            };
            if (!policy.allowed || actor === undefined) {
              const reason = policy.allowed ? 'unknown_session' : policy.reason;
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor?.tenant_id ?? row.tenant_id,
                actor_alias: actor?.alias ?? row.alias,
                action: 'terminal.session.consume',
                decision: 'deny',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(context, {
                  session_id: sid,
                  reason,
                  ticket_sha256: ticketDigest(ticket),
                }),
              });
              refusal = { status: 403, reason };
            } else if (row.ticket_redeemable) {
              const claimed = await client.query<ClaimedSession>(
                `UPDATE terminal_sessions
                    SET consumed_at=now(), relay_claim_sha256=$2, relay_claim_epoch=1,
                        relay_claimed_at=now(),
                        relay_claim_expires_at=LEAST(
                          now()+make_interval(secs => $3),
                          now()+make_interval(secs => $4)
                        ), relay_boot_id=$5
                  WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL
                    AND closed_at IS NULL AND expires_at > now()
                    AND relay_instance_id=$6
                  RETURNING *,now() AS database_now`,
                [
                  sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                  identity.relay_boot_id, identity.relay_instance_id,
                ],
              );
              session = claimed.rows[0];
              databaseNow = claimed.rows[0]?.database_now;
              if (session === undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'lifecycle_conflict',
                    ticket_sha256: ticketDigest(ticket),
                  }),
                });
                refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
            } else {
              const exactClaim = row.relay_claim_sha256 !== null
                && row.relay_claim_sha256.equals(claimSha256)
                && row.relay_instance_id === identity.relay_instance_id
                && row.relay_boot_id === identity.relay_boot_id;
              const liveClaim = row.relay_claim_expires_at !== null
                && row.relay_claim_expires_at.getTime() > row.database_now.getTime();
              if (exactClaim && liveClaim && relayClaimEpoch(row.relay_claim_epoch) !== undefined) {
                const renewed = await client.query<ClaimedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_expires_at=LEAST(
                        consumed_at+make_interval(secs => $4),
                        now()+make_interval(secs => $3)
                      )
                    WHERE id=$1 AND relay_claim_sha256=$2
                      AND relay_claim_epoch=$5::bigint
                      AND relay_claim_expires_at>now()
                      AND relay_instance_id=$6 AND relay_boot_id=$7
                      AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    row.relay_claim_epoch, identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = renewed.rows[0];
                databaseNow = renewed.rows[0]?.database_now;
                recovered = session !== undefined;
              } else if (!liveClaim) {
                const takeover = await client.query<ClaimedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_sha256=$2,
                          relay_claim_epoch=relay_claim_epoch+1,
                          relay_claimed_at=now(),
                          relay_instance_id=$5,
                          relay_boot_id=$6,
                          relay_claim_expires_at=LEAST(
                            consumed_at+make_interval(secs => $4),
                            now()+make_interval(secs => $3)
                          )
                    WHERE id=$1 AND consumed_at IS NOT NULL
                      AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                      AND (relay_claim_expires_at IS NULL OR relay_claim_expires_at<=now())
                      AND relay_claim_epoch<9223372036854775807
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = takeover.rows[0];
                databaseNow = takeover.rows[0]?.database_now;
                takenOver = session !== undefined;
              } else {
                const retryAfterMs = Math.max(
                  1,
                  Math.ceil(row.relay_claim_expires_at!.getTime() - row.database_now.getTime()),
                );
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'claim_conflict',
                    ticket_sha256: ticketDigest(ticket),
                    claim_epoch: row.relay_claim_epoch,
                  }),
                });
                refusal = { status: 409, reason: 'claim_conflict', retry_after_ms: retryAfterMs };
              }
              if (session === undefined && refusal === undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.consume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'lifecycle_conflict',
                    ticket_sha256: ticketDigest(ticket),
                  }),
                });
                refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
            }
            if (session !== undefined && actor !== undefined) {
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor.tenant_id,
                actor_alias: actor.alias,
                action: 'terminal.session.consume',
                decision: 'info',
                ...(session.trace_id === null ? {} : { trace_id: session.trace_id }),
                metadata: terminalAuditMetadata(context, {
                  session_id: sid,
                  image_id: session.image_id,
                  generation: session.generation,
                  operator_reason: session.reason,
                  cols: session.cols,
                  rows: session.rows,
                  ticket_sha256: ticketDigest(ticket),
                  receipt_recovered: recovered,
                  claim_taken_over: takenOver,
                  claim_epoch: session.relay_claim_epoch,
                  source_room_ids: policy.source_room_ids ?? [],
                }),
              });
            }
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (session === undefined) {
        if (refusal?.status === 403) {
          await reply.code(403).send({ ok: false, reason: refusal.reason });
        } else if (refusal?.status === 409) {
          await reply.code(409).send({
            ok: false,
            reason: refusal.reason,
            ...(refusal.retry_after_ms === undefined ? {} : { retry_after_ms: refusal.retry_after_ms }),
          });
        } else {
          await invalid();
        }
        return;
      }
      const expiry = sessionExpiry(session) ?? session.expires_at;
      if (session.consumed_at === null) {
        throw new Error('database consumed a terminal session without a consumed_at timestamp');
      }
      if (databaseNow === undefined) throw new Error('database omitted terminal claim clock');
      const resumeToken = issueResumeToken(
        session.id,
        session.operator_id,
        Math.floor(expiry.getTime() / 1_000),
        config.ticketKey,
        Math.floor(session.consumed_at.getTime() / 1_000)
      );
      return await reply.code(200).send({
        ...relayGrant(session, resumeToken, claimToken, databaseNow, identity),
        receipt_recovered: recovered,
        claim_taken_over: takenOver,
      });
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/resume', async (request, reply) => {
    const sid = request.params.sid;
    const refuse = async (status: 401 | 403 | 409, reason: string, retryAfterMs?: number): Promise<void> => {
      // Authentication failures intentionally share the same small body. A caller on this route
      // already passed the relay bearer gate, but a stale/forged browser credential learns no row.
      await reply.code(status).send({
        ok: false,
        reason,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      });
    };
    try {
      if (!UUID_PATTERN.test(sid)) { await refuse(401, 'resume_invalid'); return; }
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined
          || (!exactObjectKeys(record, RESUME_KEYS) && !exactObjectKeys(record, RESUME_WITH_EPOCH_KEYS))) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const token = record?.resume_token;
      const claimToken = relayClaimToken(record?.claim_token);
      const presentedEpoch = record?.claim_epoch === undefined
        ? undefined : relayClaimEpoch(record.claim_epoch);
      if (typeof token !== 'string' || token.length < 80 || token.length > 1_024
          || claimToken === undefined
          || (record?.claim_epoch !== undefined && presentedEpoch === undefined)) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedResumeSession extends TerminalSessionRow {
        database_now: Date;
        session_unexpired: boolean;
      }
      interface ClaimedSession extends TerminalSessionRow { database_now: Date }
      const client = await pool.connect();
      let transactionOpen = false;
      let session: TerminalSessionRow | undefined;
      let databaseNow: Date | undefined;
      let takenOver = false;
      let refusal: { status: 401 | 403 | 409; reason: string; retry_after_ms?: number } | undefined;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<LockedResumeSession>(
          `SELECT terminal_sessions.*,now() AS database_now,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND consumed_at+make_interval(secs => $2)>now() AS session_unexpired
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [sid, config.sessionTtlSeconds],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          refusal = { status: 401, reason: 'resume_invalid' };
        } else {
          let credential;
          try {
            credential = verifyResumeTokenSignature(token, config.ticketKey);
          } catch (error) {
            if (!(error instanceof TicketError)) throw error;
          }
          const expiry = sessionExpiry(row);
          if (credential === undefined || credential.sid !== sid || credential.op !== row.operator_id
              || expiry === undefined || credential.exp !== Math.floor(expiry.getTime() / 1_000)) {
            refusal = { status: 401, reason: 'resume_invalid' };
          } else if (row.consumed_at === null) {
            refusal = { status: 403, reason: 'not_consumed' };
          } else if (row.revoked_at !== null) {
            refusal = { status: 403, reason: 'revoked' };
          } else if (row.closed_at !== null) {
            refusal = { status: 403, reason: 'closed' };
          } else if (!row.session_unexpired) {
            refusal = { status: 403, reason: 'session_expired' };
          } else {
            const policy = await currentSessionPolicy(row, false, client);
            const actor = sessionActor(row);
            const context: TerminalAuditContext = {
              operator_id: row.operator_id,
              attributed: row.attributed,
              target_tenant: row.tenant_id,
              target_alias: row.alias,
              container: row.container,
              cohort: policy.cohort === undefined ? [] : cohortLabels(policy.cohort),
              mode: row.mode,
            };
            if (!policy.allowed || actor === undefined) {
              const reason = policy.allowed ? 'unknown_session' : policy.reason;
              await recordTransactionalTerminalAudit(client, {
                tenant_id: actor?.tenant_id ?? row.tenant_id,
                actor_alias: actor?.alias ?? row.alias,
                action: 'terminal.session.resume',
                decision: 'deny',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata(context, { session_id: sid, reason }),
              });
              refusal = { status: 403, reason };
            } else {
              const exactClaim = row.relay_claim_sha256 !== null
                && row.relay_claim_sha256.equals(claimSha256)
                && row.relay_instance_id === identity.relay_instance_id
                && row.relay_boot_id === identity.relay_boot_id;
              const liveClaim = row.relay_claim_expires_at !== null
                && row.relay_claim_expires_at.getTime() > row.database_now.getTime();
              if (exactClaim && liveClaim && presentedEpoch === row.relay_claim_epoch) {
                const renewed = await client.query<ClaimedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_expires_at=LEAST(
                        consumed_at+make_interval(secs => $4),
                        now()+make_interval(secs => $3)
                      )
                    WHERE id=$1 AND relay_claim_sha256=$2 AND relay_claim_epoch=$5::bigint
                      AND relay_claim_expires_at>now()
                      AND relay_instance_id=$6 AND relay_boot_id=$7
                      AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    presentedEpoch, identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = renewed.rows[0];
                databaseNow = renewed.rows[0]?.database_now;
              } else if (liveClaim) {
                const retryAfterMs = Math.max(
                  1,
                  Math.ceil(row.relay_claim_expires_at!.getTime() - row.database_now.getTime()),
                );
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.resume',
                  decision: 'deny',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    reason: 'claim_conflict',
                    claim_epoch: row.relay_claim_epoch,
                  }),
                });
                refusal = { status: 409, reason: 'claim_conflict', retry_after_ms: retryAfterMs };
              } else {
                const takeover = await client.query<ClaimedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_sha256=$2,
                          relay_claim_epoch=relay_claim_epoch+1,
                          relay_claimed_at=now(),
                          relay_instance_id=$5,
                          relay_boot_id=$6,
                          relay_claim_expires_at=LEAST(
                            consumed_at+make_interval(secs => $4),
                            now()+make_interval(secs => $3)
                          )
                    WHERE id=$1 AND consumed_at IS NOT NULL
                      AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                      AND (relay_claim_expires_at IS NULL OR relay_claim_expires_at<=now())
                      AND relay_claim_epoch<9223372036854775807
                    RETURNING *,now() AS database_now`,
                  [
                    sid, claimSha256, config.claimLeaseSeconds, config.sessionTtlSeconds,
                    identity.relay_instance_id, identity.relay_boot_id,
                  ],
                );
                session = takeover.rows[0];
                databaseNow = takeover.rows[0]?.database_now;
                takenOver = session !== undefined;
                if (session === undefined) refusal = { status: 409, reason: 'lifecycle_conflict' };
              }
              if (session !== undefined) {
                await recordTransactionalTerminalAudit(client, {
                  tenant_id: actor.tenant_id,
                  actor_alias: actor.alias,
                  action: 'terminal.session.resume',
                  decision: 'info',
                  ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                  metadata: terminalAuditMetadata(context, {
                    session_id: sid,
                    claim_epoch: session.relay_claim_epoch,
                    claim_taken_over: takenOver,
                  }),
                });
              }
            }
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (session === undefined) {
        await refuse(
          refusal?.status ?? 409,
          refusal?.reason ?? 'lifecycle_conflict',
          refusal?.retry_after_ms,
        );
        return;
      }
      if (databaseNow === undefined) throw new Error('database omitted terminal claim clock');
      return await reply.code(200).send({
        ...relayGrant(session, token, claimToken, databaseNow, identity),
        claim_taken_over: takenOver,
      });
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/authz', async (request, reply) => {
    try {
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : undefined;
      if (record === undefined || !exactObjectKeys(record, AUTHZ_KEYS)) {
        await reply.code(403).send({ ok: false, reason: 'claim_fenced' });
        return;
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) { await reply.code(401).send(); return; }
      const claimToken = relayClaimToken(record?.claim_token);
      const claimEpoch = relayClaimEpoch(record?.claim_epoch);
      if (claimToken === undefined || claimEpoch === undefined) {
        await reply.code(403).send({ ok: false, reason: 'claim_fenced' });
        return;
      }
      const claimSha256 = ticketSha256(claimToken);
      interface LockedAuthzSession extends TerminalSessionRow {
        database_now: Date;
        session_expires_at: Date | null;
        session_unexpired: boolean;
      }
      interface RenewedSession extends TerminalSessionRow {
        database_now: Date;
        session_expires_at: Date;
      }
      const client = await pool.connect();
      let transactionOpen = false;
      let renewed: RenewedSession | undefined;
      let refusal = 'unknown_session';
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<LockedAuthzSession>(
          `SELECT terminal_sessions.*,now() AS database_now,
                  consumed_at+make_interval(secs => $2) AS session_expires_at,
                  consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                    AND consumed_at+make_interval(secs => $2)>now() AS session_unexpired
             FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [request.params.sid, config.sessionTtlSeconds],
        );
        const row = locked.rows[0];
        if (row !== undefined) {
          if (row.consumed_at === null) refusal = 'not_consumed';
          else if (row.revoked_at !== null) refusal = 'revoked';
          else if (row.closed_at !== null) refusal = 'closed';
          else if (!row.session_unexpired) refusal = 'session_expired';
          else {
            const exactClaim = row.relay_claim_sha256 !== null
              && row.relay_claim_sha256.equals(claimSha256)
              && row.relay_claim_epoch === claimEpoch
              && row.relay_instance_id === identity.relay_instance_id
              && row.relay_boot_id === identity.relay_boot_id
              && row.relay_claim_expires_at !== null
              && row.relay_claim_expires_at.getTime() > row.database_now.getTime();
            if (!exactClaim) {
              refusal = 'claim_fenced';
            } else {
              const policy = await currentSessionPolicy(row, false, client);
              refusal = policy.reason;
              if (policy.allowed) {
                const result = await client.query<RenewedSession>(
                  `UPDATE terminal_sessions
                      SET relay_claim_expires_at=LEAST(
                        consumed_at+make_interval(secs => $4),
                        now()+make_interval(secs => $3)
                      )
                    WHERE id=$1 AND relay_claim_sha256=$2 AND relay_claim_epoch=$5::bigint
                      AND relay_claim_expires_at>now()
                      AND relay_instance_id=$6 AND relay_boot_id=$7
                      AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
                      AND consumed_at+make_interval(secs => $4)>now()
                    RETURNING *,now() AS database_now,
                              consumed_at+make_interval(secs => $4) AS session_expires_at`,
                  [
                    request.params.sid,
                    claimSha256,
                    config.claimLeaseSeconds,
                    config.sessionTtlSeconds,
                    claimEpoch,
                    identity.relay_instance_id,
                    identity.relay_boot_id,
                  ],
                );
                renewed = result.rows[0];
                if (renewed === undefined) refusal = 'claim_fenced';
              }
            }
          }
          if (renewed === undefined) {
            await recordTransactionalTerminalAudit(client, {
              tenant_id: row.tenant_id,
              actor_alias: row.alias,
              action: 'terminal.session.revoked',
              decision: 'info',
              ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
              metadata: terminalAuditMetadata({
                operator_id: row.operator_id,
                attributed: row.attributed,
                target_tenant: row.tenant_id,
                target_alias: row.alias,
                container: row.container,
                cohort: [],
                mode: row.mode,
              }, {
                session_id: row.id,
                reason: refusal,
                claim_epoch: row.relay_claim_epoch,
              }),
            });
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (renewed === undefined) {
        await reply.code(403).send({ ok: false, reason: refusal });
        return;
      }
      return {
        ok: true,
        expires_at: renewed.session_expires_at.toISOString(),
        claim_epoch: databaseClaimEpoch(renewed.relay_claim_epoch),
        claim_lease_ms: boundedMilliseconds(
          renewed.relay_claim_expires_at!,
          renewed.database_now,
          config.claimLeaseSeconds * 1_000,
        ),
        claim_lease_ttl_ms: config.claimLeaseSeconds * 1_000,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/close', async (request, reply) => {
    try {
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      if (!exactObjectKeys(record, CLOSE_KEYS) && !exactObjectKeys(record, CLOSE_WITH_CLAIM_KEYS)) {
        throw new Error('terminal close report has unexpected or missing fields');
      }
      const identity = requestRelayIdentity(request, record);
      if (identity === undefined) return await reply.code(401).send();
      const reason = typeof record.reason === 'string' && record.reason.length > 0
        ? record.reason.slice(0, 128) : 'relay_closed';
      const exitCode = typeof record.exit_code === 'number' && Number.isSafeInteger(record.exit_code)
        ? record.exit_code : null;
      const bytesIn = boundedInteger(record.bytes_in ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_in');
      const bytesOut = boundedInteger(record.bytes_out ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_out');
      const rawClaimToken = record.claim_token;
      const rawClaimEpoch = record.claim_epoch;
      const claimToken = rawClaimToken === undefined ? undefined : relayClaimToken(rawClaimToken);
      const claimEpoch = rawClaimEpoch === undefined ? undefined : relayClaimEpoch(rawClaimEpoch);
      const malformedClaim = (rawClaimToken !== undefined || rawClaimEpoch !== undefined)
        && (claimToken === undefined || claimEpoch === undefined);
      const claimSha256 = claimToken === undefined ? undefined : ticketSha256(claimToken);
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<TerminalSessionRow>(
          `SELECT * FROM terminal_sessions WHERE id=$1 FOR UPDATE`,
          [request.params.sid],
        );
        const existing = locked.rows[0];
        if (existing !== undefined && existing.closed_at === null) {
          const legacy = !malformedClaim && claimToken === undefined && claimEpoch === undefined
            && existing.relay_claim_sha256 === null && existing.relay_claim_epoch === '0'
            && existing.relay_instance_id === identity.relay_instance_id
            && existing.relay_boot_id === null;
          const exact = !malformedClaim && claimSha256 !== undefined && claimEpoch !== undefined
            && existing.relay_claim_sha256 !== null
            && existing.relay_claim_sha256.equals(claimSha256)
            && existing.relay_claim_epoch === claimEpoch
            && existing.relay_instance_id === identity.relay_instance_id
            && existing.relay_boot_id === identity.relay_boot_id;
          if (!legacy && !exact) {
            // A stale spooled close is terminally acknowledged so it does not retry forever, but
            // it is observable and can never mutate the current ownership generation.
            await recordTransactionalTerminalAudit(client, {
              tenant_id: existing.tenant_id,
              actor_alias: existing.alias,
              action: 'terminal.session.close',
              decision: 'deny',
              ...(existing.trace_id === null ? {} : { trace_id: existing.trace_id }),
              metadata: terminalAuditMetadata({
                operator_id: existing.operator_id,
                attributed: existing.attributed,
                target_tenant: existing.tenant_id,
                target_alias: existing.alias,
                container: existing.container,
                cohort: [],
                mode: existing.mode,
              }, {
                session_id: existing.id,
                reason: malformedClaim ? 'malformed_claim' : 'stale_claim',
                claim_epoch: existing.relay_claim_epoch,
              }),
            });
          } else {
            const closed = await client.query<TerminalSessionRow>(
              `UPDATE terminal_sessions
                  SET closed_at=now(), close_reason=$2, bytes_in=$3, bytes_out=$4
                WHERE id=$1 AND closed_at IS NULL
                  AND (
                    ($5::boolean AND relay_claim_sha256 IS NULL AND relay_claim_epoch=0)
                    OR
                    (NOT $5::boolean AND relay_claim_sha256=$6 AND relay_claim_epoch=$7::bigint)
                  )
                  AND relay_instance_id=$8
                  AND relay_boot_id IS NOT DISTINCT FROM $9::uuid
                RETURNING *`,
              [
                request.params.sid,
                reason,
                bytesIn,
                bytesOut,
                legacy,
                claimSha256 ?? null,
                claimEpoch ?? '0',
                identity.relay_instance_id,
                legacy ? null : identity.relay_boot_id,
              ],
            );
            const row = closed.rows[0];
            if (row !== undefined) {
              await recordTransactionalTerminalAudit(client, {
                tenant_id: row.tenant_id,
                actor_alias: row.alias,
                action: 'terminal.session.close',
                decision: 'info',
                ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
                metadata: terminalAuditMetadata({
                  operator_id: row.operator_id,
                  attributed: row.attributed,
                  target_tenant: row.tenant_id,
                  target_alias: row.alias,
                  container: row.container,
                  cohort: [],
                  mode: row.mode,
                }, {
                  session_id: row.id,
                  image_id: row.image_id,
                  generation: row.generation,
                  operator_reason: row.reason,
                  close_reason: reason,
                  exit_code: exitCode,
                  bytes_in: counterValue(row.bytes_in),
                  bytes_out: counterValue(row.bytes_out),
                  claim_epoch: row.relay_claim_epoch,
                }),
              });
            }
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return await reply.code(200).send({
        ok: true,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      });
    } catch (error) { replyError(reply, error); }
  });
}

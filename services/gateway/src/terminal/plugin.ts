import { createHash, timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CauceRepository, StoreError, type DatabaseClient, type DatabasePool,
  type AuthorizedAgentTarget,
} from '@cauce/store';
import { AliasSchema, TenantSchema, type Tenant } from '@cauce/protocol';
import {
  AuthError, AuthorizationError, validatePrincipal,
  type AuthProvider, type Principal
} from '../auth.js';
import {
  type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import { terminalAuditMetadata, type TerminalAuditContext, type TerminalAuditEntry } from './audit.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetIdentityLabel,
  fleetPlacement, loadFleetPlacements,
} from './authority.js';
import type { TerminalConfig } from './config.js';
import { createGovernanceProbes } from './governance-probes.js';
import {
  AgentRegistry, RelayBootConflictError, parseAgentPresence,
  type RelayProcessIdentity,
} from './registry.js';
import {
  registerTerminalSessionControl, TerminalClockSkewError, type DeleteSessionBody,
  type OwnerRotationBody, type SessionRequestBody,
} from './session-control.js';
import {
  deriveAliasKey, issueResumeToken, ticketDigest, ticketSha256,
  verifyResumeTokenSignature, verifyTicketSignature,
  TicketError, type TicketPayload
} from './tickets.js';
import { isTerminalMode, type TerminalSessionRow } from './types.js';

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

function counterValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function browserOwnerGeneration(value: string): string {
  const generation = relayClaimEpoch(value);
  if (generation === undefined) throw new Error('database browser owner generation is invalid');
  return generation;
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

  registerTerminalSessionControl(app, {
    pool,
    config,
    registry,
    grants,
    repository,
    UUID_PATTERN,
    principal,
    openPredicate,
    currentCohort,
    cohortLabels,
    sessionExpiry,
    parseSessionRequest,
    parseOwnerRotation,
    parseDeleteSession,
    browserOwnerGeneration,
    replyError,
    recordTransactionalTerminalAudit,
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

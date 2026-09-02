import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CauceRepository, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import {
  AliasSchema, isCanonicalUuidV4, TenantSchema,
} from '@cauce/protocol';
import { validatePrincipal, type AuthProvider, type Principal } from '../auth.js';
import {
  type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import { replyError as replyCanonicalError } from '../routes/shared.js';
import type { TerminalAuditEntry } from './audit.js';
import {
  GrantStore, containerCohort, loadFleetPlacements,
} from './authority.js';
import type { TerminalConfig } from './config.js';
import { createGovernanceProbes } from './governance-probes.js';
import { boundedInteger, exactObjectKeys, type TerminalControlRepository } from './helpers.js';
import { AgentRegistry } from './registry.js';
import { registerTerminalRelayProxy, relayClaimEpoch } from './relay-proxy.js';
import {
  registerTerminalSessionControl, TerminalClockSkewError, type DeleteSessionBody,
  type OwnerRotationBody, type SessionRequestBody,
} from './session-control.js';
import { isTerminalMode } from './types.js';

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
 * enabled registry resolves placement; the release gate proves that registry matches the inventory.
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
const SESSION_REQUEST_KEYS = [
  'alias', 'cols', 'mode', 'owner_token', 'reason', 'request_id', 'rows', 'tenant_id',
] as const;
const OWNER_ROTATION_KEYS = [
  'expected_owner_generation', 'owner_token', 'request_id',
] as const;
const DELETE_SESSION_KEYS = ['owner_generation', 'owner_token', 'request_id'] as const;

interface TerminalControlPlaneOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly config: TerminalConfig;
  /** Injectable for tests; production uses a fresh in-memory registry per process. */
  readonly registry?: AgentRegistry;
  readonly repository?: TerminalControlRepository;
  /**
   * Where the measured facts of each alias (harness, HOME, CODEX_HOME) come from to resolve the
   * path to its site manual.
   */
  readonly measuredFacts?: MeasuredFactsSource;
  /** Injectable for tests; in production it comes from `config.relayUrl`. */
  readonly governanceRelay?: GovernanceRelayClient;
  /** Test seam only. Production hashes the verified TLS peer leaf directly from the socket. */
  readonly relayPeerInstanceId?: (request: FastifyRequest) => string | undefined;
}

/** Adds the only status this plane owns; everything else follows the canonical mapping. */
export function replyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof TerminalClockSkewError) {
    void reply.code(503).send({
      error: 'terminal_clock_skew',
      message: 'terminal issuance is unavailable until gateway and PostgreSQL clocks agree'
    });
    return;
  }
  replyCanonicalError(reply, error);
}

function canonicalUuidV4(value: unknown, name: string): string {
  if (!isCanonicalUuidV4(value)) {
    throw new Error(`${name} must be a canonical UUIDv4`);
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
    throw new Error(`reason must be between ${String(REASON_MIN)} and ${String(REASON_MAX)} characters`);
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
  const grants = new GrantStore(config.grantsFile, (message) => { app.log.warn(message); });
  const repository = options.repository ?? new CauceRepository(pool);

  async function principal(request: FastifyRequest): Promise<Principal> {
    return validatePrincipal(await authProvider.authenticateHttp(request));
  }

  /** Open = neither closed nor revoked, and still inside its ticket or session window. */
  function openPredicate(ttlParameter: number): string {
    return `closed_at IS NULL AND revoked_at IS NULL
            AND ((consumed_at IS NULL AND expires_at > now())
                 OR (consumed_at IS NOT NULL AND consumed_at + make_interval(secs => $${String(ttlParameter)}) > now()))`;
  }

  async function currentCohort(
    tenantId: string,
    alias: string,
    database: DatabasePool | DatabaseClient = pool,
  ) {
    const placements = await loadFleetPlacements(database);
    return containerCohort(placements, tenantId, alias);
  }

  registerTerminalSessionControl(app, {
    pool,
    config,
    registry,
    grants,
    repository,
    principal,
    openPredicate,
    currentCohort,
    parseSessionRequest,
    parseOwnerRotation,
    parseDeleteSession,
    browserOwnerGeneration,
    replyError,
    recordTransactionalTerminalAudit,
  });
  /* ------------------------------------------------------------------ */
  /* Browser route: the DIRECTIVE of an alias                            */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /v3/console/agents/:tenant/:alias/directive` lives here, not in app.ts, because its
   * content only exists when the terminal plane exists: the text comes from the pty-agent and
   * travels through the terminal-relay. With `CAUCE_TERMINAL_ENABLED` off there is nowhere to
   * read it from, and a route that would only answer "unavailable" is worse than no route at all.
   *
   * By hanging off `/v3/console/` it inherits the console security hook (Origin, Sec-Fetch-Site)
   * that app.ts installs BEFORE this plugin, like the rest of the browser routes.
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

  registerTerminalRelayProxy(app, {
    pool,
    config,
    registry,
    grants,
    repository,
    relayPeerInstanceId: options.relayPeerInstanceId,
    replyError,
    recordTransactionalTerminalAudit,
  });
}

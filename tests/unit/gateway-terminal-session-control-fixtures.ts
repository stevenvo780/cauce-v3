// Shared fixtures for session-control test files.
// Not a test file: not picked up by vitest.
// Imported by per-route test files to avoid duplicating 200+ lines per file.

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import type { Principal } from '../../services/gateway/src/auth.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import {
  browserOwnerGeneration, parseControlRequest, parseDeleteSession, parseOwnerRotation,
  parseSessionExtend, parseSessionRequest, replyError,
} from '../../services/gateway/src/terminal/plugin.js';
import {
  registerTerminalSessionControl, type ControlRequestBody, type DeleteSessionBody,
  type ExtendSessionBody, type OwnerRotationBody, type SessionRequestBody,
} from '../../services/gateway/src/terminal/session-control.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import type { FleetPlacement, TerminalSessionRow } from '../../services/gateway/src/terminal/types.js';

/**
 * Hermetic tests for the terminal-plane orchestrator.
 *
 * `registerTerminalSessionControl` registers four routes (POST/GET sessions, POST owner,
 * DELETE session) and depends on Postgres pool, AgentRegistry, GrantStore, authorization
 * repository, validators and audit helpers. This suite targets only the surface that does
 * NOT require real Postgres or WebSocket:
 *
 *   - Exported constant `TerminalClockSkewError` (custom error class).
 *   - Pre-validation of the four routes: shape, regex, attributes and orchestrator errors
 *     BEFORE opening a transaction.
 *   - Pure logic of the helpers (`sessionState`, `terminalRelayWebsocketPath`,
 *     `terminalAdmissionRequestSha256`, `ticketTtlSeconds`, `operatorLockIdentity`,
 *     `operatorScopePredicate`) exercised through mock-captured responses and queries.
 *
 * Paths that DO require `pool.connect()` (real BEGIN/SELECT/UPDATE/COMMIT) and the
 * INSERT INTO terminal_sessions are out of scope here; those are covered by
 * integration/e2e.
 */

export const RELAY_INSTANCE_ID = 'a'.repeat(64);
export const UUID_OK = '11111111-1111-4111-8111-111111111111';
export const REQUEST_ID_OK = '22222222-2222-4222-8222-222222222222';
export const OWNER_TOKEN_OK = '33333333-3333-4333-8333-333333333333';

export function consolePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Steven',
    alias: 'kant',
    session_id: 'console-session-1',
    channel: 'console',
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
    operator_id: 'steven-kant',
    ...overrides
  };
}

export function unattributedConsolePrincipal(): Principal {
  const { operator_id: _omit, ...rest } = consolePrincipal();
  void _omit;
  return rest;
}

export function configBase(): TerminalConfig {
  return {
    wsPath: '/v3/console/terminal/ws',
    ticketKey: Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64'),
    relayToken: 'relay-token-that-is-long-enough-0123456789',
    relayInstanceIds: new Set([RELAY_INSTANCE_ID]),
    grantsFile: '/tmp/cauce-grants.json',
    ticketTtlSeconds: 30,
    sessionTtlSeconds: 30,
    sessionMaxTotalSeconds: 3_600,
    controlHoldSeconds: 900,
    writableTuiEnabled: true,
    claimLeaseSeconds: 150,
    maxSessionsPerOperator: 2,
    operatorHeader: 'x-cauce-operator',
    operators: new Set(['steven-kant']),
  };
}

export function validSessionBody(overrides: Partial<SessionRequestBody> = {}): SessionRequestBody {
  return {
    tenant_id: 'Steven',
    alias: 'jarvis',
    mode: 'shell',
    initiator: 'operator',
    reason: 'revisar el harness colgado',
    cols: 120,
    rows: 40,
    request_id: REQUEST_ID_OK,
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

export function validOwnerRotation(overrides: Partial<OwnerRotationBody> = {}): OwnerRotationBody {
  return {
    request_id: REQUEST_ID_OK,
    expected_owner_generation: '1',
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

export function validDeleteSession(overrides: Partial<DeleteSessionBody> = {}): DeleteSessionBody {
  return {
    request_id: REQUEST_ID_OK,
    owner_generation: '1',
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

export function validExtendSession(overrides: Partial<ExtendSessionBody> = {}): ExtendSessionBody {
  return validDeleteSession(overrides);
}

export function validControlRequest(overrides: Partial<ControlRequestBody> = {}): ControlRequestBody {
  return {
    action: 'take',
    reason: 'tomar la TUI para desatascar el turno',
    request_id: REQUEST_ID_OK,
    owner_generation: '1',
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

export interface ContextOptions {
  readonly pool?: DatabasePool;
  readonly registry?: AgentRegistry;
  readonly grants?: {
    allowsCohort: ReturnType<typeof vi.fn>;
    allows?: ReturnType<typeof vi.fn>;
  };
  readonly repository?: {
    assertPermission?: ReturnType<typeof vi.fn>;
    authorizeAgentTarget?: ReturnType<typeof vi.fn>;
  };
  readonly principal?: (request: unknown) => Promise<Principal>;
  readonly replyError?: (reply: FastifyReply, error: unknown) => void;
  readonly recordTransactionalTerminalAudit?: ReturnType<typeof vi.fn>;
  readonly config?: Partial<TerminalConfig>;
  readonly cohort?: FleetPlacement[];
}

export interface Context {
  readonly app: FastifyInstance;
  readonly pool: DatabasePool;
  readonly registry: AgentRegistry;
  readonly grants: { allowsCohort: ReturnType<typeof vi.fn> };
  readonly repository: { assertPermission: ReturnType<typeof vi.fn>; authorizeAgentTarget: ReturnType<typeof vi.fn> };
  readonly replyError: ReturnType<typeof vi.fn>;
  readonly recordTransactionalTerminalAudit: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

export function buildContext(options: ContextOptions = {}): Context {
  const pool: DatabasePool = options.pool ?? {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => stubClient())
  } as unknown as DatabasePool;
  const registry = options.registry ?? new AgentRegistry();
  const grants = options.grants ?? {
    allowsCohort: vi.fn(async () => true),
    allows: vi.fn(async () => true)
  };
  const repository = {
    assertPermission: options.repository?.assertPermission ?? vi.fn(async () => undefined),
    authorizeAgentTarget: options.repository?.authorizeAgentTarget ?? vi.fn(async () => undefined)
  };
  const recordTransactionalTerminalAudit = options.recordTransactionalTerminalAudit ?? vi.fn(async () => undefined);
  const cohort = options.cohort ?? [
    { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw' },
  ];
  const app = Fastify({ logger: false });

  registerTerminalSessionControl(app, {
    pool,
    config: { ...configBase(), ...options.config },
    registry,
    grants: grants as never,
    repository,
    principal: options.principal ?? (async () => consolePrincipal()),
    openPredicate: (ttlParameter: number) =>
      `closed_at IS NULL AND revoked_at IS NULL AND ((consumed_at IS NULL AND expires_at > now()) OR (consumed_at IS NOT NULL AND consumed_at + make_interval(secs => $${String(ttlParameter)}) > now()))`,
    currentCohort: async () => cohort,
    parseSessionRequest,
    parseOwnerRotation,
    parseDeleteSession,
    parseControlRequest,
    parseSessionExtend,
    browserOwnerGeneration,
    replyError: options.replyError ?? replyError,
    recordTransactionalTerminalAudit
  });
  return {
    app,
    pool,
    registry,
    grants,
    repository,
    replyError: (options.replyError ?? replyError) as unknown as ReturnType<typeof vi.fn>,
    recordTransactionalTerminalAudit,
    async close() { await app.close(); }
  };
}
// `on`/`off` are required: withTransaction (packages/store/src/db.ts) attaches an 'error'
// listener to every checkout, and a client without them fails before the first query.
export function transactionClient(
  handleQuery: (
    text: string,
    values: unknown[],
  ) => { rows: unknown[]; rowCount: number } | Promise<{ rows: unknown[]; rowCount: number }>,
): DatabaseClient {
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      return handleQuery(text, values);
    }),
    release: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DatabaseClient;
}

export function stubClient(): DatabaseClient {
  return transactionClient((text) => {
    if (text.includes('clock_timestamp')) return { rows: [{ database_now: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

export interface FleetPlacementRow {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_name: string;
  readonly runtime_user: string;
}

/**
 * Pool stub with three configurable behaviors:
 *  - SELECT against `agents` (loadFleetPlacements) returns `placements` mapped to the
 *    real query shape (`container_name`).
 *  - SELECT against `terminal_sessions` (GET /sessions) returns `selectList.rows`.
 *  - SELECT against `memberships` (routingAuthority) returns a shared `grp.steven` room
 *    so cohortRoutingAuthority approves the same-tenant path.
 *  - Any other query returns [] without throwing (does not break the happy path).
 */
export function stubFleetPool(
  placements: readonly FleetPlacementRow[],
  options: { selectList?: readonly TerminalSessionRow[] } = {}
): DatabasePool & { __queries: { text: string; values: unknown[] }[] } {
  const selectList = options.selectList ?? [];
  const queries: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('FROM agents')) {
        return { rows: placements, rowCount: placements.length };
      }
      if (text.includes('FROM terminal_sessions')) {
        return { rows: selectList, rowCount: selectList.length };
      }
      if (text.includes("'actor'::text AS side")) {
        return {
          rows: [
            { side: 'actor', room_id: 'grp.steven' },
            { side: 'target', room_id: 'grp.steven' }
          ],
          rowCount: 2
        };
      }
      if (text.includes('FROM acl_edges')) {
        return { rows: [{ ok: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => stubClient()),
    __queries: queries
  };
  return pool as unknown as DatabasePool & { __queries: typeof queries };
}

export function makeRow(overrides: Partial<TerminalSessionRow> & { occupies_slot?: boolean }): TerminalSessionRow {
  const issuedAt = overrides.issued_at ?? new Date('2026-01-01T00:00:00Z');
  const expiresAt = overrides.expires_at ?? new Date('2026-01-01T00:00:30Z');
  const base: TerminalSessionRow = {
    id: overrides.id ?? UUID_OK,
    request_id: REQUEST_ID_OK,
    request_sha256: Buffer.alloc(32),
    browser_owner_sha256: Buffer.alloc(32),
    browser_owner_generation: '1',
    operator_id: 'steven-kant',
    attributed: true,
    console_subject: 'Steven:kant',
    tenant_id: 'Steven',
    alias: 'jarvis',
    container: 'claw',
    generation: 'gen-1',
    image_id: 'sha256:abc',
    runtime_user: 'claw',
    mode: 'shell',
    ticket_sha256: Buffer.alloc(32),
    reason: 'revisar el harness colgado',
    cols: 120,
    rows: 40,
    trace_id: null,
    issued_at: issuedAt,
    expires_at: expiresAt,
    consumed_at: null,
    relay_claim_epoch: '0',
    relay_claim_sha256: null,
    relay_claimed_at: null,
    relay_claim_expires_at: null,
    relay_instance_id: RELAY_INSTANCE_ID,
    relay_boot_id: null,
    revoked_at: null,
    closed_at: null,
    close_reason: null,
    bytes_in: 0,
    bytes_out: 0
  };
  return { ...base, ...overrides };
}
// Shared fixtures for session-control test files.
// Not a test file: not picked up by vitest.
// Imported by per-route test files to avoid duplicating 200+ lines per file.

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import {
  AuthError, AuthorizationError
} from '../../services/gateway/src/auth.js';
import type { Principal } from '../../services/gateway/src/auth.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import {
  registerTerminalSessionControl, TerminalClockSkewError,
  type DeleteSessionBody, type OwnerRotationBody, type SessionRequestBody,
} from '../../services/gateway/src/terminal/session-control.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import type { TerminalSessionRow } from '../../services/gateway/src/terminal/types.js';
import { StoreError } from '@cauce/store';

/**
 * Tests herméticos del orquestador del plano terminal.
 *
 * `registerTerminalSessionControl` registra cuatro rutas (POST/GET sessions, POST owner,
 * DELETE session) y depende de pool Postgres, AgentRegistry, GrantStore, repositorio
 * de autorización, validadores y helpers de auditoría. Esta suite ataca solo la superficie
 * que NO necesita tocar Postgres real ni WebSocket:
 *
 *   - Constante exportada `TerminalClockSkewError` (clase de error custom).
 *   - Pre-validación de las cuatro rutas: shape, regex, atributos y errores del orquestador
 *     ANTES de abrir transacción.
 *   - Lógica pura de los helpers (`sessionState`, `terminalRelayWebsocketPath`,
 *     `terminalAdmissionRequestSha256`, `ticketTtlSeconds`, `operatorLockIdentity`,
 *     `operatorScopePredicate`) que se ejerce a través de respuestas y queries
 *     capturadas por mocks.
 *
 * Los caminos que SI requieren `pool.connect()` (BEGIN/SELECT/UPDATE/COMMIT real) y los
 * INSERT INTO terminal_sessions quedan fuera de cobertura; esa pieza se prueba en
 * integration/e2e.
 */

export const RELAY_INSTANCE_ID = 'a'.repeat(64);
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  readonly sessionExpiry?: (row: TerminalSessionRow) => Date | undefined;
  readonly recordTransactionalTerminalAudit?: ReturnType<typeof vi.fn>;
}

export interface Context {
  readonly app: FastifyInstance;
  readonly pool: DatabasePool;
  readonly registry: AgentRegistry;
  readonly grants: { allowsCohort: ReturnType<typeof vi.fn> };
  readonly repository: { assertPermission: ReturnType<typeof vi.fn>; authorizeAgentTarget: ReturnType<typeof vi.fn> };
  readonly replyError: ReturnType<typeof vi.fn>;
  readonly recordTransactionalTerminalAudit: ReturnType<typeof vi.fn>;
  readonly sessionExpiry: ReturnType<typeof vi.fn>;
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
  const sessionExpiry = options.sessionExpiry ?? vi.fn(() => undefined);
  const recordTransactionalTerminalAudit = options.recordTransactionalTerminalAudit ?? vi.fn(async () => undefined);
  const app = Fastify({ logger: false });

  function realReplyError(reply: FastifyReply, error: unknown): void {
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

  registerTerminalSessionControl(app, {
    pool,
    config: configBase(),
    registry,
    grants: grants as never,
    repository,
    UUID_PATTERN,
    principal: options.principal ?? (async () => consolePrincipal()),
    openPredicate: (ttlParameter: number) =>
      `closed_at IS NULL AND revoked_at IS NULL AND ((consumed_at IS NULL AND expires_at > now()) OR (consumed_at IS NOT NULL AND consumed_at + make_interval(secs => $${String(ttlParameter)}) > now()))`,
    currentCohort: async () => [{
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw'
    }],
    cohortLabels: (cohort) => cohort.map((member) => `${member.tenant_id}:${member.alias}`),
    sessionExpiry,
    parseSessionRequest: (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('session request must be an object');
      }
      const record = value as Record<string, unknown>;
      if (typeof record.tenant_id !== 'string') throw new Error('tenant_id is required');
      if (typeof record.alias !== 'string') throw new Error('alias is invalid');
      if (record.mode !== 'shell' && record.mode !== 'harness') throw new Error("mode must be 'shell' or 'harness'");
      if (typeof record.reason !== 'string' || record.reason.length < 8 || record.reason.length > 280) {
        throw new Error('reason must be between 8 and 280 characters');
      }
      if (typeof record.cols !== 'number' || record.cols < 20 || record.cols > 500) {
        throw new Error('cols must be an integer between 20 and 500');
      }
      if (typeof record.rows !== 'number' || record.rows < 5 || record.rows > 200) {
        throw new Error('rows must be an integer between 5 and 200');
      }
      if (typeof record.request_id !== 'string') throw new Error('request_id is required');
      if (typeof record.owner_token !== 'string') throw new Error('owner_token is required');
      return {
        tenant_id: record.tenant_id,
        alias: record.alias,
        mode: record.mode,
        reason: record.reason,
        cols: record.cols,
        rows: record.rows,
        request_id: record.request_id,
        owner_token: record.owner_token
      };
    },
    parseOwnerRotation: (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('owner rotation request must be an object');
      }
      const record = value as Record<string, unknown>;
      if (typeof record.request_id !== 'string') throw new Error('request_id is required');
      if (typeof record.owner_token !== 'string') throw new Error('owner_token is required');
      if (typeof record.expected_owner_generation !== 'string'
          || !/^[1-9][0-9]*$/.test(record.expected_owner_generation)) {
        throw new Error('expected_owner_generation is invalid');
      }
      return {
        request_id: record.request_id,
        expected_owner_generation: record.expected_owner_generation,
        owner_token: record.owner_token
      };
    },
    parseDeleteSession: (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('terminal session release must be an object');
      }
      const record = value as Record<string, unknown>;
      if (typeof record.request_id !== 'string') throw new Error('request_id is required');
      if (typeof record.owner_token !== 'string') throw new Error('owner_token is required');
      if (typeof record.owner_generation !== 'string'
          || !/^[1-9][0-9]*$/.test(record.owner_generation)) {
        throw new Error('owner_generation is invalid');
      }
      return {
        request_id: record.request_id,
        owner_generation: record.owner_generation,
        owner_token: record.owner_token
      };
    },
    browserOwnerGeneration: (value) => {
      if (!/^[0-9]+$/.test(value) || value === '0') throw new Error('owner generation is invalid');
      return value;
    },
    replyError: options.replyError ?? realReplyError,
    recordTransactionalTerminalAudit
  });
  return {
    app,
    pool,
    registry,
    grants,
    repository,
    replyError: (options.replyError ?? realReplyError) as unknown as ReturnType<typeof vi.fn>,
    sessionExpiry: sessionExpiry as unknown as ReturnType<typeof vi.fn>,
    recordTransactionalTerminalAudit,
    async close() { await app.close(); }
  };
}
export function stubClient(): DatabaseClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('clock_timestamp')) return { rows: [{ database_now: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as DatabaseClient;
}

/* -------------------------------------------------------------------------- */
/* Helpers de fixtures                                                          */
/* -------------------------------------------------------------------------- */

export interface FleetPlacementRow {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_name: string;
  readonly runtime_user: string;
}

/**
 * Pool stub con tres comportamientos configurables:
 *  - SELECT contra `agents` (loadFleetPlacements) devuelve `placements` mapeados al shape
 *    de la query real (`container_name`).
 *  - SELECT contra `terminal_sessions` (GET /sessions) devuelve `selectList.rows`.
 *  - SELECT contra `memberships` (routingAuthority) devuelve una sala compartida
 *    `grp.steven` para que cohortRoutingAuthority apruebe el camino same-tenant.
 *  - Cualquier otra query devuelve [] sin lanzar (no rompe el camino happy).
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
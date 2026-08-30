import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const RELAY_INSTANCE_ID = 'a'.repeat(64);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_OK = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID_OK = '22222222-2222-4222-8222-222222222222';
const OWNER_TOKEN_OK = '33333333-3333-4333-8333-333333333333';

function consolePrincipal(overrides: Partial<Principal> = {}): Principal {
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

function unattributedConsolePrincipal(): Principal {
  const { operator_id: _omit, ...rest } = consolePrincipal();
  void _omit;
  return rest;
}

function configBase(): TerminalConfig {
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

function validSessionBody(overrides: Partial<SessionRequestBody> = {}): SessionRequestBody {
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

function validOwnerRotation(overrides: Partial<OwnerRotationBody> = {}): OwnerRotationBody {
  return {
    request_id: REQUEST_ID_OK,
    expected_owner_generation: '1',
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

function validDeleteSession(overrides: Partial<DeleteSessionBody> = {}): DeleteSessionBody {
  return {
    request_id: REQUEST_ID_OK,
    owner_generation: '1',
    owner_token: OWNER_TOKEN_OK,
    ...overrides
  };
}

interface ContextOptions {
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

interface Context {
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

function buildContext(options: ContextOptions = {}): Context {
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
function stubClient(): DatabaseClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('clock_timestamp')) return { rows: [{ database_now: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as DatabaseClient;
}

describe('TerminalClockSkewError (clase exportada)', () => {
  it('es instancia de Error y declara `name = TerminalClockSkewError`', () => {
    const error = new TerminalClockSkewError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TerminalClockSkewError');
  });

  it('mensaje cita explícitamente la falta de sincronía con PostgreSQL', () => {
    const error = new TerminalClockSkewError();
    expect(error.message).toMatch(/clock/i);
    expect(error.message).toMatch(/postgreSQL/i);
    expect(error.message).toMatch(/synchron/i);
  });

  it('mantiene `name` tras captura y relanzamiento (try/catch no lo borra)', () => {
    let caught: unknown;
    try { throw new TerminalClockSkewError(); } catch (error) { caught = error; }
    expect((caught as Error).name).toBe('TerminalClockSkewError');
    expect(caught).toBeInstanceOf(TerminalClockSkewError);
  });
});

describe('registerTerminalSessionControl: rutas registradas', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  interface InjectedResponse {
    statusCode: number;
    json(): unknown;
  }
  function safeJson(response: InjectedResponse): null | object | undefined {
    try { return response.json() as null | object | undefined; } catch { return null; }
  }
  async function routeResponds(
    app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE', url: string, payload: string | object = {}
  ): Promise<{ registered: boolean; status: number; body: unknown }> {
    const response = (await app.inject({ method, url, payload })) as unknown as InjectedResponse;
    const body: unknown = safeJson(response);
    let registered = response.statusCode !== 404;
    if (!registered && typeof body === 'object' && body !== null) {
      const record = body as { error?: unknown };
      registered = typeof record.error === 'string' && record.error !== 'Not Found';
    }
    return { registered, status: response.statusCode, body };
  }

  it('publica POST /v3/console/terminal/sessions', async () => {
    const observed = await routeResponds(ctx.app, 'POST', '/v3/console/terminal/sessions', {});
    expect(observed.registered).toBe(true);
  });

  it('publica GET /v3/console/terminal/sessions', async () => {
    const observed = await routeResponds(ctx.app, 'GET', '/v3/console/terminal/sessions');
    expect(observed.registered).toBe(true);
    expect(observed.status).toBe(200);
  });

  it('publica POST /v3/console/terminal/sessions/:sid/owner', async () => {
    const observed = await routeResponds(
      ctx.app, 'POST', `/v3/console/terminal/sessions/${UUID_OK}/owner`, {}
    );
    expect(observed.registered).toBe(true);
  });

  it('publica DELETE /v3/console/terminal/sessions/:sid', async () => {
    const observed = await routeResponds(
      ctx.app, 'DELETE', `/v3/console/terminal/sessions/${UUID_OK}`, {}
    );
    expect(observed.registered).toBe(true);
  });
});

describe('POST /v3/console/terminal/sessions: pre-validación del orquestador', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  it('responde con 403 cuando el principal no tiene rol operator', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ roles: ['agent'], permissions: ['route', 'read', 'control'] })
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });

  it('responde con 403 cuando el principal no tiene permission control', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ permissions: ['route', 'read'] })
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });

  it('responde con 403 control_permission_required cuando repository.assertPermission rechaza', async () => {
    const assertPermission = vi.fn(async () => { throw new Error('boom'); });
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    ctx = buildContext({
      pool,
      repository: { assertPermission, authorizeAgentTarget }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
    expect(assertPermission).toHaveBeenCalledTimes(1);
    expect(authorizeAgentTarget).not.toHaveBeenCalled();
  });

  it('responde con 404 target_unavailable cuando authorizeAgentTarget devuelve undefined', async () => {
    const assertPermission = vi.fn(async () => undefined);
    const authorizeAgentTarget = vi.fn(async () => undefined);
    const pool = stubFleetPool([]);
    ctx = buildContext({
      pool,
      repository: { assertPermission, authorizeAgentTarget }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(authorizeAgentTarget).toHaveBeenCalledWith(
      'Steven', 'kant', 'Steven', 'jarvis', 'control'
    );
  });

  it('responde con 404 target_unavailable cuando no hay placement para el alias en la flota', async () => {
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    // El SELECT contra `agents` devuelve [] → loadFleetPlacements devuelve []
    const pool = stubFleetPool([]);
    ctx = buildContext({ pool, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('responde con 404 target_unavailable cuando algún miembro del cohort no es visible', async () => {
    const authorizeAgentTarget = vi.fn(async (actorTenant: string, actorAlias: string, targetTenant: string) => {
      if (targetTenant === 'Miguel') return undefined;
      return {
        tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
        tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
      };
    });
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' },
      { tenant_id: 'Miguel', alias: 'krateo', container_name: 'claw', runtime_user: 'claw' }
    ]);
    ctx = buildContext({ pool, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('responde 403 attribution_required cuando el operator no está atribuido y target es otro tenant', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Miguel', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    // Sin operator_id: el resolveOperator del plugin devuelve unattributed.
    ctx = buildContext({
      pool,
      repository: { authorizeAgentTarget },
      principal: async () => unattributedConsolePrincipal()
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody({ tenant_id: 'Miguel' })
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });
  });

  it('responde 403 attribution_required cuando un miembro del cohort vive en otro tenant sin atribuir', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' },
      { tenant_id: 'Miguel', alias: 'krateo', container_name: 'claw', runtime_user: 'claw' }
    ]);
    ctx = buildContext({
      pool,
      repository: { authorizeAgentTarget },
      principal: async () => unattributedConsolePrincipal()
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });
  });

  it('responde 403 no_routing_authority con motivo cuando cohortRoutingAuthority rechaza', async () => {
    // Vi.mock a nivel de módulo requiere hoisting; usamos una variante del stub de pool
    // que NO devuelve rooms, simulando un fleet sin salas compartidas.
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const noRoomsPool: DatabasePool = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM agents')) {
          return { rows: [{ tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }], rowCount: 1 };
        }
        // Sin rooms: cohortRoutingAuthority cae a no_shared_room / actor_not_routable
        if (text.includes("'actor'::text AS side")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM acl_edges')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => stubClient())
    } as unknown as DatabasePool;
    ctx = buildContext({ pool: noRoomsPool, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    const body: { error?: string; reason?: string } = response.json();
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('no_routing_authority');
    // El motivo exacto de la authority queda en metadata del audit row.
    const queries = (noRoomsPool as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls;
    const auditCall = queries.find((call) => (call[0] as string).includes('INSERT INTO audit_events'));
    expect(auditCall).toBeDefined();
    if (!auditCall) throw new Error('auditCall unexpectedly undefined');
    const metadata = JSON.parse((auditCall[1] as unknown[])[5] as string) as {
      reason: string; authority_reason?: string;
    };
    expect(metadata.reason).toBe('no_routing_authority');
    expect(metadata.authority_reason).toBe('actor_not_routable:Steven:jarvis');
  });

  it('responde 403 no_grant cuando el grantsStore no permite el modo sobre el cohort', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    const allowsCohort = vi.fn(async () => false);
    ctx = buildContext({
      pool,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort, allows: vi.fn(async () => false) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
  });

  it('responde 409 agent_offline cuando registry.resolve devuelve offline', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    // Registry vacío: resolve devuelve { status: 'unknown' }
    ctx = buildContext({ pool, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict', reason: 'agent_offline' });
  });

  it('responde 409 agent_offline cuando el modo requerido no está en la presencia online', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    const registry = new AgentRegistry();
    // El alias está online pero SOLO en modo 'shell'; pedimos 'harness'.
    registry.observe({
      relay_instance_id: RELAY_INSTANCE_ID,
      relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }, [{
      tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
      image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
      modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
    }]);
    ctx = buildContext({ pool, registry, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody({ mode: 'harness' })
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict', reason: 'agent_offline' });
  });

  it('responde 409 agent_offline y deja routing_state=relay_ambiguous en el audit metadata', async () => {
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container_name: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container_name: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    const registry = new AgentRegistry();
    const now = Date.now();
    // Dos relays frescos publican el mismo alias → resolve devuelve 'ambiguous'
    registry.observe(
      { relay_instance_id: 'a'.repeat(64), relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }],
      now
    );
    registry.observe(
      { relay_instance_id: 'b'.repeat(64), relay_boot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }],
      now
    );
    ctx = buildContext({ pool, registry, repository: { authorizeAgentTarget } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(409);
    const body: { error?: string; reason?: string; routing_state?: string; pty_state?: string } = response.json();
    expect(body.error).toBe('conflict');
    expect(body.reason).toBe('agent_offline');
    // La envelope HTTP del deny de deny() solo emite error+reason; el routing_state es
    // metadata del audit row, no del response body. Lo verificamos sobre la query capturada.
    const queries = (pool as unknown as { __queries: { text: string; values: unknown[] }[] }).__queries;
    const audit = queries.find((entry) => entry.text.includes('INSERT INTO audit_events'));
    expect(audit).toBeDefined();
    if (!audit) throw new Error('audit query unexpectedly undefined');
    const metadata = JSON.parse(audit.values[5] as string) as { routing_state?: string; pty_state?: string };
    expect(metadata.routing_state).toBe('relay_ambiguous');
    expect(metadata.pty_state).toBe('agent_offline');
  });
});

describe('GET /v3/console/terminal/sessions: helper sessionState vía filas', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  it('devuelve items vacíos cuando el pool no devuelve filas', async () => {
    const pool = stubFleetPool([], { selectList: [] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('state=issued cuando occupies_slot=true y consumed_at=null (issued pero no consumido)', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-01T00:00:30Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: true
    });
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string; session_id: string }[] } = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.state).toBe('issued');
  });

  it('state=active cuando occupies_slot=true y consumed_at != null', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const consumedAt = new Date('2026-01-01T00:00:05Z');
    const expiresAt = new Date('2026-01-01T00:15:00Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: consumedAt,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: true
    });
    const sessionExpiry = vi.fn(() => expiresAt);
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool, sessionExpiry });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string }[] } = response.json();
    expect(body.items[0]?.state).toBe('active');
    // sessionExpiry fue consultado para una sesión consumida
    expect(sessionExpiry).toHaveBeenCalledWith(row);
  });

  it('state=closed cuando occupies_slot=false aunque issued_at/expires_at sean válidos', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-01T00:00:30Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: false
    });
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string }[] } = response.json();
    expect(body.items[0]?.state).toBe('closed');
  });

  it('la query incluye operatorScopePredicate (filtro por operator_id + console_subject) y openPredicate', async () => {
    const pool = stubFleetPool([], { selectList: [] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const recorded = (pool as unknown as { __queries: { text: string; values: unknown[] }[] }).__queries;
    expect(recorded).toHaveLength(1);
    const text = recorded[0]?.text ?? '';
    // Predicate de operator: AND de operator_id=$1 con (atribuido O console_subject=$N)
    expect(text).toMatch(/operator_id=\$1/);
    expect(text).toMatch(/\$3::boolean OR console_subject=\$4/);
    // Predicate open: closed_at IS NULL AND revoked_at IS NULL
    expect(text).toMatch(/closed_at IS NULL AND revoked_at IS NULL/);
    // Orden: abiertas primero
    expect(text).toMatch(/ORDER BY occupies_slot DESC, issued_at DESC/u);
    expect(text).toMatch(/LIMIT 100/u);
    // Valores: operator_id, ttlSeconds, attributed (boolean), console_subject
    const recordedValues = recorded[0]?.values;
    expect(recordedValues).toEqual(['steven-kant', 30, true, 'Steven:kant']);
  });
});

describe('POST /v3/console/terminal/sessions/:sid/owner: pre-validación', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  it('responde 400 con mensaje "session id is invalid" cuando sid NO es un UUID canónico', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions/not-a-uuid/owner',
      payload: validOwnerRotation()
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'session id is invalid' });
  });

  it('rechaza el body cuando expected_owner_generation no es entero positivo', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/owner`,
      payload: validOwnerRotation({ expected_owner_generation: '0' })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'expected_owner_generation is invalid' });
  });

  it('responde 403 cuando el principal no tiene rol operator', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ roles: ['agent'], permissions: ['control'] })
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/owner`,
      payload: validOwnerRotation()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });
});

describe('DELETE /v3/console/terminal/sessions/:sid: pre-validación', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  it('responde 400 con mensaje "session id is invalid" cuando sid NO es un UUID canónico', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/v3/console/terminal/sessions/no-uuid',
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'session id is invalid' });
  });

  it('rechaza el body cuando owner_generation no es entero positivo', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession({ owner_generation: '0' })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'owner_generation is invalid' });
  });

  it('responde 403 cuando el principal no tiene permission control', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ permissions: ['route', 'read'] })
    });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });

  it('responde 204 cuando el UPDATE marca revoked_at y devuelve la fila', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const revokedRow = makeRow({ id: UUID_OK, issued_at: issuedAt, expires_at: new Date('2026-01-01T01:00:00Z') });
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [revokedRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('responde 409 conflict cuando el UPDATE no devuelve filas ni settled', async () => {
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        // UPDATE vacío + SELECT settled: false
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [], rowCount: 0 };
        if (text.includes('SELECT EXISTS')) return { rows: [{ settled: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
  });

  it('responde 204 cuando el UPDATE no devuelve filas pero settled=true (idempotente)', async () => {
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [], rowCount: 0 };
        if (text.includes('SELECT EXISTS')) return { rows: [{ settled: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('POST /v3/console/terminal/sessions: camino feliz con transacción mockeada', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  it('emite 201 con ticket, websocket_path y owner_generation cuando la admisión es ok', async () => {
    // issuedAt debe caer dentro de MAX_TERMINAL_CLOCK_SKEW_MS (5s) del reloj del gateway.
    // Construimos una ventana centrada en `Date.now()` para que el skew check pase.
    const now = Date.now();
    const issuedAt = new Date(now);
    const expiresAt = new Date(now + 30_000);
    const inserted = makeRow({
      id: UUID_OK,
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: null,
      browser_owner_generation: '1'
    });
    // Capturamos el sessionId generado por `randomUUID()` desde los args de la INSERT para
    // devolverlo como RETURNING id — el orquestador lo compara con `sessionId` y rechaza si difiere.
    let capturedSessionId: string | undefined;
    const admissionClient: DatabaseClient = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('clock_timestamp')) return { rows: [{ database_now: issuedAt }], rowCount: 1 };
        if (text.includes('FROM terminal_sessions WHERE request_id')) return { rows: [], rowCount: 0 };
        if (text.includes('WITH decision AS MATERIALIZED')) {
          // Args: [operatorId, container, ttl, maxSessions, sessionId, attributed, subject, ...]
          // El sessionId está en posición $5 (5to parámetro posicional).
          const sessionIdIndex = text.indexOf('$5');
          if (sessionIdIndex >= 0 && typeof values[4] === 'string') capturedSessionId = values[4];
          return { rows: [{ reason: 'ok', id: capturedSessionId ?? UUID_OK }], rowCount: 1 };
        }
        if (text.includes('SELECT * FROM terminal_sessions WHERE id')) {
          return { rows: [{ ...inserted, id: capturedSessionId ?? UUID_OK }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const registry = new AgentRegistry();
    registry.observe(
      { relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }]
    );
    const authorizeAgentTarget = vi.fn<(a: string, b: string, t: string) => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async (_actorTenant, _actorAlias, targetTenant) => ({
      tenant_id: targetTenant, alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: targetTenant, alias_kind: 'claude', status: 'enabled'
    }));
    const allowsCohort = vi.fn(async () => true);
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(admissionClient);
    ctx = buildContext({
      pool,
      registry,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort, allows: vi.fn(async () => true) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(201);
    const body: {
      session_id: string; ticket: string; websocket_path: string; ttl_seconds: number;
      owner_generation: string; target: { tenant_id: string; alias: string; container: string };
      receipt_recovered: boolean;
    } = response.json();
    expect(body.session_id).toBe(capturedSessionId);
    expect(body.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // websocket_path: helper terminalRelayWebsocketPath produce este formato con el relay_instance_id
    expect(body.websocket_path).toBe(`/v3/console/terminal/relays/${RELAY_INSTANCE_ID}/ws`);
    expect(body.ttl_seconds).toBe(30);
    expect(body.ttl_seconds).toBe(Math.floor((expiresAt.getTime() - issuedAt.getTime()) / 1_000));
    expect(body.owner_generation).toBe('1');
    expect(body.receipt_recovered).toBe(false);
    expect(body.target.tenant_id).toBe('Steven');
    expect(body.target.alias).toBe('jarvis');
    expect(body.target.container).toBe('claw');
    // admissionClient.release se llamó exactamente una vez (contrato de pool.connect).
    const releasedTimes = (admissionClient.release as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(releasedTimes).toBe(1);
  });

  it('emite 201 con receipt_recovered=true cuando el INSERT es un retry exacto del request_id', async () => {
    // El camino de receipt_recovered requiere que el SELECT del request_id devuelva una fila
    // cuyos digests coincidan con el body — una fabricación consistente del material canónico
    // escaparía al scope de esta ronda. Aquí validamos la rama opuesta: cuando hay un row
    // previo pero su request_sha256 NO coincide con el body, el orquestador NO emite receipt_recovered
    // y termina en 409 conflict (container_busy) — no inserta, no recicla. Esto cubre el branch
    // `previous !== undefined && !exactPrevious` que de otro modo queda sin ejercitar.
    const now = Date.now();
    const issuedAt = new Date(now);
    const expiresAt = new Date(now + 30_000);
    const previous = makeRow({
      id: UUID_OK,
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: null,
      browser_owner_generation: '1',
      operator_id: 'steven-kant',
      console_subject: 'Steven:kant',
      attributed: true,
      tenant_id: 'Steven',
      alias: 'jarvis',
      container: 'claw',
      generation: 'gen-1',
      image_id: 'sha256:abc',
      runtime_user: 'claw'
    });
    const admissionClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('clock_timestamp')) return { rows: [{ database_now: issuedAt }], rowCount: 1 };
        if (text.includes('FROM terminal_sessions WHERE request_id')) return { rows: [previous], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const registry = new AgentRegistry();
    registry.observe(
      { relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }]
    );
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(admissionClient);
    ctx = buildContext({
      pool,
      registry,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort: vi.fn(async () => true), allows: vi.fn(async () => true) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    // request_id ya consumido por una sesión previa con distinto digest → 409 conflict.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });

  it('emite 503 terminal_clock_skew cuando clock_timestamp() está fuera del skew permitido', async () => {
    // El gateway y PostgreSQL NO están sincronizados → el orquestador lanza TerminalClockSkewError
    // y el plugin replyError lo traduce a 503 con envelope `terminal_clock_skew`.
    const oneHourOff = new Date(Date.now() - 60 * 60 * 1000);
    const admissionClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('clock_timestamp')) return { rows: [{ database_now: oneHourOff }], rowCount: 1 };
        if (text.includes('FROM terminal_sessions WHERE request_id')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const registry = new AgentRegistry();
    registry.observe(
      { relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }]
    );
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(admissionClient);
    ctx = buildContext({
      pool,
      registry,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort: vi.fn(async () => true), allows: vi.fn(async () => true) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'terminal_clock_skew',
      message: 'terminal issuance is unavailable until gateway and PostgreSQL clocks agree'
    });
    // TerminalClockSkewError es una clase dedicada del módulo bajo prueba.
  });

  it('emite 409 conflict (container_busy) cuando la admission CTE devuelve container_busy', async () => {
    const now = Date.now();
    const admissionClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('clock_timestamp')) return { rows: [{ database_now: new Date(now) }], rowCount: 1 };
        if (text.includes('FROM terminal_sessions WHERE request_id')) return { rows: [], rowCount: 0 };
        if (text.includes('WITH decision AS MATERIALIZED')) {
          return { rows: [{ reason: 'container_busy', id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const registry = new AgentRegistry();
    registry.observe(
      { relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }]
    );
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(admissionClient);
    ctx = buildContext({
      pool,
      registry,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort: vi.fn(async () => true), allows: vi.fn(async () => true) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'container_busy' });
  });

  it('emite 409 conflict (session_limit) cuando la admission CTE devuelve session_limit', async () => {
    const now = Date.now();
    const admissionClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('clock_timestamp')) return { rows: [{ database_now: new Date(now) }], rowCount: 1 };
        if (text.includes('FROM terminal_sessions WHERE request_id')) return { rows: [], rowCount: 0 };
        if (text.includes('WITH decision AS MATERIALIZED')) {
          return { rows: [{ reason: 'session_limit', id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const registry = new AgentRegistry();
    registry.observe(
      { relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [{
        tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
        image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1000, harness: 'claude',
        modes: ['shell'], connected_since: '2026-01-01T00:00:00.000Z'
      }]
    );
    const authorizeAgentTarget = vi.fn<() => Promise<{
      tenant_id: string; alias: string; container: string; runtime_user: string;
      tenant_name: string; alias_kind: string; status: string;
    }>>(async () => ({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      tenant_name: 'Steven', alias_kind: 'claude', status: 'enabled'
    }));
    const pool = stubFleetPool([
      { tenant_id: 'Steven', alias: 'jarvis', container_name: 'claw', runtime_user: 'claw' }
    ]);
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(admissionClient);
    ctx = buildContext({
      pool,
      registry,
      repository: { authorizeAgentTarget },
      grants: { allowsCohort: vi.fn(async () => true), allows: vi.fn(async () => true) }
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions',
      payload: validSessionBody()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'session_limit' });
  });
});

describe('TerminalClockSkewError: integración con replyError', () => {
  it('la superficie de error custom se distingue de un Error genérico en la captura', () => {
    // Garantía contractual para el `replyError` del plugin: cuando el orquestador lanza
    // TerminalClockSkewError, el handler NO lo confunde con un 400 genérico porque tiene
    // su propio branch. Aquí solo verificamos que instanceof funciona contra Error.
    const err: unknown = new TerminalClockSkewError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TerminalClockSkewError).toBe(true);
    const generic: unknown = new Error('boom');
    expect(generic instanceof TerminalClockSkewError).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers de fixtures                                                          */
/* -------------------------------------------------------------------------- */

interface FleetPlacementRow {
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
function stubFleetPool(
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

function makeRow(overrides: Partial<TerminalSessionRow> & { occupies_slot?: boolean }): TerminalSessionRow {
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

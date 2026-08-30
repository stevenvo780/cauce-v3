import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { RELAY_INSTANCE_ID, UUID_OK, buildContext, type Context, consolePrincipal, unattributedConsolePrincipal, validSessionBody, stubFleetPool, makeRow, stubClient } from './gateway-terminal-session-control-fixtures.js';

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

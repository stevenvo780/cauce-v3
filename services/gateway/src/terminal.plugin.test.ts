import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { AuthError, type AuthProvider, type Principal } from './auth.js';
import type { RelayFileRead, RuntimeFacts } from './console/agent-documents.js';
import type { FactsSource, GovernanceReadError } from './console/agent-documents.routes.js';
import { createConsoleSecurityHook } from './console-security.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { AgentRegistry } from './terminal/registry.js';
import { deriveAliasKey, parseAndVerify } from './terminal/tickets.js';
import { UNATTRIBUTED_OPERATOR, type AgentPresence, type TerminalSessionRow } from './terminal/types.js';

/**
 * Control-plane behaviour end to end over app.inject, with the same console security hook
 * app.ts installs in production. The database is a substitute: these tests are about the
 * decisions and the audit trail, not about PostgreSQL.
 */

const ORIGIN = 'https://consola.elenxos.com';
const RELAY_TOKEN = 'relay-token-that-is-long-enough-0123456789';
const MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');

interface AuditRow {
  tenant_id: string;
  actor_alias: string;
  action: string;
  decision: string;
  metadata: Record<string, unknown>;
}

interface FakeDatabase {
  pool: DatabasePool;
  sessions: Map<string, TerminalSessionRow>;
  audit: AuditRow[];
  rooms: Record<string, string[]>;
  edges: string[];
}

function isOpen(row: TerminalSessionRow, ttlSeconds: number, now: number): boolean {
  if (row.closed_at !== null || row.revoked_at !== null) return false;
  if (row.consumed_at === null) return row.expires_at.getTime() > now;
  return row.consumed_at.getTime() + ttlSeconds * 1_000 > now;
}

function fakeDatabase(): FakeDatabase {
  const sessions = new Map<string, TerminalSessionRow>();
  const audit: AuditRow[] = [];
  const state = {
    rooms: {
      'Steven:kant': ['grp.steven'],
      'Steven:jarvis': ['grp.steven'],
      'Steven:argos': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:atlas': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    } as Record<string, string[]>,
    edges: ['Steven->Miguel'] as string[]
  };

  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const now = Date.now();
    if (text.includes('INSERT INTO audit_events')) {
      const [tenantId, actorAlias, action, decision, , metadata] = values as [string, string, string, string, unknown, string];
      audit.push({
        tenant_id: tenantId, actor_alias: actorAlias, action, decision,
        metadata: JSON.parse(metadata) as Record<string, unknown>
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO terminal_sessions')) {
      const [
        id, operatorId, attributed, subject, tenantId, alias, container, generation, imageId,
        runtimeUser, mode, ticketSha256, reason, cols, rows, traceId, expiresAt
      ] = values as [
        string, string, boolean, string, string, string, string, string, string,
        string, 'shell' | 'harness', Buffer, string, number, number, string, string
      ];
      sessions.set(id, {
        id, operator_id: operatorId, attributed, console_subject: subject, tenant_id: tenantId,
        alias, container, generation, image_id: imageId, runtime_user: runtimeUser, mode,
        ticket_sha256: ticketSha256, reason, cols, rows, trace_id: traceId,
        issued_at: new Date(now), expires_at: new Date(expiresAt), consumed_at: null,
        revoked_at: null, closed_at: null, close_reason: null, bytes_in: 0, bytes_out: 0
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SELECT count(*)::int AS open FROM terminal_sessions')) {
      const open = [...sessions.values()].filter((row) => text.includes('WHERE operator_id=$1')
        ? row.operator_id === values[0] && isOpen(row, values[1] as number, now)
        : row.container === values[0] && row.operator_id !== values[1] && isOpen(row, values[2] as number, now));
      return { rows: [{ open: open.length }], rowCount: 1 };
    }
    if (text.includes('SELECT * FROM terminal_sessions WHERE id=$1')) {
      const row = sessions.get(values[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('SELECT * FROM terminal_sessions WHERE operator_id=$1')) {
      const rows = [...sessions.values()].filter((row) => row.operator_id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SET consumed_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.consumed_at !== null || row.revoked_at !== null || row.expires_at.getTime() <= now) {
        return { rows: [], rowCount: 0 };
      }
      row.consumed_at = new Date(now);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SET revoked_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.operator_id !== values[1] || row.revoked_at !== null || row.closed_at !== null) {
        return { rows: [], rowCount: 0 };
      }
      row.revoked_at = new Date(now);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SET closed_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.closed_at !== null) return { rows: [], rowCount: 0 };
      row.closed_at = new Date(now);
      row.close_reason = values[1] as string;
      row.bytes_in = values[2] as number;
      row.bytes_out = values[3] as number;
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('acl_edges')) {
      const [from, to] = values as [string, string];
      const rows = state.edges.includes(`${from}->${to}`) ? [{ ok: true }] : [];
      return { rows, rowCount: rows.length };
    }
    const [actorTenant, actorAlias, targetTenant, targetAlias] = values as [string, string, string, string];
    const rows = [
      ...(state.rooms[`${actorTenant}:${actorAlias}`] ?? []).map((room_id) => ({ side: 'actor', room_id })),
      ...(state.rooms[`${targetTenant}:${targetAlias}`] ?? []).map((room_id) => ({ side: 'target', room_id }))
    ];
    return { rows, rowCount: rows.length };
  };

  return { pool: { query } as unknown as DatabasePool, sessions, audit, rooms: state.rooms, edges: state.edges };
}

/** The single console certificate in production: Steven:kant, operator, route+read+control. */
function consoleAuthProvider(overrides: Partial<Principal> = {}): AuthProvider {
  const actor: Principal = {
    tenant_id: 'Steven', alias: 'kant', session_id: 'console-session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'], ...overrides
  };
  return {
    name: 'test-console', mode: 'test',
    authenticateHttp: async () => actor,
    authenticateHello: async () => actor
  };
}

function presence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-7',
    image_id: 'sha256:c0ffee', runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw',
    modes: ['shell', 'harness'], connected_since: new Date().toISOString(),
    ...overrides
  };
}

describe('terminal control plane', () => {
  let directory: string;
  let grantsFile: string;
  let database: FakeDatabase;
  let registry: AgentRegistry;
  let app: FastifyInstance;
  let config: TerminalConfig;
  let controlPermission: () => Promise<void>;
  /** Hechos MEDIDOS por alias. Vacío = nadie midió ese contenedor, que es el estado de hoy. */
  let hechos: Map<string, { facts: RuntimeFacts; source: FactsSource }>;
  /** Todo lo que el gateway le pidió al terminal-relay, en orden. */
  let pedidas: Array<{ tenant_id: string; alias: string; path: string }>;
  let leer: (path: string) => RelayFileRead | GovernanceReadError;

  async function build(overrides: Partial<TerminalConfig> = {}, provider = consoleAuthProvider()): Promise<void> {
    // A test that rebuilds with another config must not leak the instance beforeEach created.
    if (app !== undefined) await app.close();
    config = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: MASTER,
      relayToken: RELAY_TOKEN,
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set<string>(),
      ...overrides
    };
    app = Fastify({ logger: false });
    // Same hook app.ts installs before the plugin; it must cover the console routes and must
    // NOT cover the relay routes, which is exactly why those live outside /v3/console/.
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [ORIGIN] }));
    await app.register(registerTerminalControlPlane, {
      pool: database.pool,
      authProvider: provider,
      config,
      registry,
      repository: { assertPermission: async () => { await controlPermission(); } },
      measuredFacts: { factsFor: async (tenantId, alias) => hechos.get(`${tenantId}:${alias}`) },
      // El terminal-relay es lo único sustituido: montar el relay entero aquí probaría el relay,
      // no el plugin. Lo que sí se registra es QUÉ rutas se le llegan a pedir, que es la parte
      // que el gateway decide.
      governanceRelay: {
        readFile: async (tenantId, alias, path) => {
          pedidas.push({ tenant_id: tenantId, alias, path });
          return leer(path);
        }
      }
    });
    await app.ready();
  }

  async function report(agents: readonly AgentPresence[]): Promise<void> {
    const response = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { agents }
    });
    expect(response.statusCode).toBe(200);
  }

  async function grant(entries: Array<{ operator?: string; tenant_id: string; alias: string; modes: string[] }>): Promise<void> {
    await writeFile(grantsFile, JSON.stringify({
      version: 1,
      grants: entries.map((entry) => ({ operator: entry.operator ?? '*', ...entry }))
    }));
  }

  async function openSession(
    body: Record<string, unknown>, headers: Record<string, string> = {}
  ): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
    return app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      headers: { origin: ORIGIN, ...headers },
      payload: {
        tenant_id: 'Steven', alias: 'jarvis', mode: 'shell',
        reason: 'revisar el harness colgado', cols: 120, rows: 40, ...body
      }
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-'));
    grantsFile = join(directory, 'grants.json');
    database = fakeDatabase();
    registry = new AgentRegistry();
    controlPermission = async () => undefined;
    hechos = new Map();
    pedidas = [];
    leer = (path) => ({
      path, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z', content: '# Manual\n'
    });
    await grant([{ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }]);
    await build();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('lists the fifteen aliases with an explicit PTY state and never a bare grey button', async () => {
    await report([presence()]);
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      websocket_path: string;
      items: Array<Record<string, unknown>>;
    }>();
    expect(body.websocket_path).toBe('/v3/console/terminal/ws');
    expect(body.items).toHaveLength(15);
    for (const item of body.items) {
      expect(['online', 'agent_offline', 'not_installed', 'unknown']).toContain(item.pty_state);
      expect(typeof item.reason).toBe('string');
      expect((item.reason as string).length).toBeGreaterThan(0);
    }
    const jarvis = body.items.find((item) => item.alias === 'jarvis');
    expect(jarvis).toMatchObject({
      pty_state: 'online', authorized: true, container: 'claw', runtime_user: 'claw',
      harness: 'openclaw', image: 'sha256:c0ffee', shares_container_with: [], modes: ['shell', 'harness']
    });
    const argos = body.items.find((item) => item.alias === 'argos');
    // argos shares ctrl-infra with kant and no agent was ever reported there.
    expect(argos).toMatchObject({ pty_state: 'not_installed', authorized: false, shares_container_with: ['kant'] });
    const iza = body.items.find((item) => item.alias === 'iza');
    // Cross-tenant without attribution: denied, and the denial reveals nothing about the target.
    expect(iza).toMatchObject({
      authorized: false, container: null, runtime_user: null, harness: null, image: null,
      reason: 'sin autoridad sobre iza', shares_container_with: ['atlas', 'kratos']
    });
  });

  it('issues a verifiable ticket, records the operator reason and audits the allow', async () => {
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      session_id: string; ticket: string; websocket_path: string; ttl_seconds: number;
      target: Record<string, unknown>;
    }>();
    expect(body.ttl_seconds).toBe(30);
    expect(body.websocket_path).toBe('/v3/console/terminal/ws');
    expect(body.target).toEqual({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      mode: 'shell', shares_container_with: []
    });
    const payload = parseAndVerify(body.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    expect(payload).toMatchObject({
      v: 1, sid: body.session_id, op: UNATTRIBUTED_OPERATOR, sub: 'Steven:kant', mode: 'shell',
      tgt: { tenant: 'Steven', alias: 'jarvis', container: 'claw', generation: 'gen-7', uid: 1000, user: 'claw' }
    });
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant', decision: 'allow' });
    expect(allow?.metadata).toMatchObject({
      operator_id: UNATTRIBUTED_OPERATOR, attributed: false, target_alias: 'jarvis', container: 'claw',
      image_id: 'sha256:c0ffee', generation: 'gen-7', mode: 'shell',
      operator_reason: 'revisar el harness colgado', cols: 120, rows: 40
    });
    // Only the truncated digest of the ticket is ever persisted in the audit trail.
    expect(allow?.metadata.ticket_sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(allow?.metadata)).not.toContain(body.ticket);
  });

  it('refuses a reason shorter than eight characters', async () => {
    await report([presence()]);
    const response = await openSession({ reason: 'corto' });
    expect(response.statusCode).toBe(400);
    expect(database.audit).toHaveLength(0);
  });

  it('HARD INVARIANT: an unattributed operator cannot reach another tenant, and the deny is audited', async () => {
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({ tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev' })]);
    const response = await openSession({ tenant_id: 'Miguel', alias: 'iza' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });
    expect(database.audit).toEqual([expect.objectContaining({
      action: 'terminal.session.request', decision: 'deny',
      metadata: expect.objectContaining({ reason: 'attribution_required', target_alias: 'iza' }) as unknown
    })]);
  });

  it('accepts a cross-tenant target once the console names an enrolled human operator', async () => {
    await build({ operators: new Set(['steven']) });
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{ target: Record<string, unknown> }>();
    // The dialog must be able to say out loud who else lives in that container.
    expect(body.target.shares_container_with).toEqual(['atlas', 'kratos']);
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow?.metadata).toMatchObject({ operator_id: 'steven', attributed: true, cohort: ['atlas', 'iza', 'kratos'] });
  });

  it('SET RULE: a grant on iza alone does not open the container shared with atlas and kratos', async () => {
    await build({ operators: new Set(['steven']) });
    await grant([{ tenant_id: 'Miguel', alias: 'iza', modes: ['shell'] }]);
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    expect(database.audit.at(-1)?.decision).toBe('deny');
  });

  it('denies every target when grants.json is missing, without restarting anything', async () => {
    await rm(grantsFile);
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    const targets = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(targets.json<{ items: Array<{ authorized: boolean }> }>().items.every((item) => !item.authorized)).toBe(true);
  });

  it('refuses a target with no live pty-agent and reports why', async () => {
    const response = await openSession({});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'agent_offline' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({ reason: 'agent_offline', pty_state: 'unknown' });
  });

  it('refuses when the database has withdrawn the control permission', async () => {
    await report([presence()]);
    controlPermission = () => Promise.reject(new Error('principal lacks control permission'));
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('caps concurrent sessions per operator', async () => {
    await build({ maxSessionsPerOperator: 1 });
    await report([presence()]);
    expect((await openSession({})).statusCode).toBe(201);
    const second = await openSession({});
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'conflict', reason: 'session_limit' });
  });

  it('rejects a relay call without the shared token and says nothing about why', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: RELAY_TOKEN }]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/terminal/relay/agents', headers, payload: { agents: [] }
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe('');
    }
  });

  it('redeems a ticket once and answers 409 on the replay', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const consume = async (): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> =>
      app.inject({
        method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { ticket: issued.ticket }
      });
    const first = await consume();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true, tenant_id: 'Steven', alias: 'jarvis', mode: 'shell', cols: 120, rows: 40,
      operator_id: UNATTRIBUTED_OPERATOR, container: 'claw', runtime_user: 'claw'
    });
    const consumed = first.json<{ expires_at: string; session_expires_at: string }>();
    expect(Date.parse(consumed.session_expires_at) - Date.parse(consumed.expires_at))
      .toBeGreaterThan((config.sessionTtlSeconds - config.ticketTtlSeconds - 5) * 1_000);
    const replay = await consume();
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ ok: false, reason: 'already_consumed' });
    expect(database.audit.filter((row) => row.action === 'terminal.session.consume')).toEqual([
      expect.objectContaining({ decision: 'info' }),
      expect.objectContaining({ decision: 'deny', metadata: expect.objectContaining({ reason: 'already_consumed' }) as unknown })
    ]);
  });

  it('rejects a ticket signed with another alias key', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const payload = parseAndVerify(issued.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    const { issueTicket } = await import('./terminal/tickets.js');
    const forged = issueTicket(payload, deriveAliasKey(MASTER, 'Steven', 'argos'));
    const response = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { ticket: forged }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, reason: 'ticket_invalid' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('revalidates a live session and cuts it as soon as grants.json is emptied', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { ticket: issued.ticket }
    });
    const authz = async (): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> =>
      app.inject({
        method: 'GET', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` }
      });
    expect((await authz()).statusCode).toBe(200);
    await grant([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const cut = await authz();
    expect(cut.statusCode).toBe(403);
    expect(cut.json()).toEqual({ ok: false, reason: 'no_grant' });
    expect(database.audit.at(-1)).toMatchObject({
      action: 'terminal.session.revoked',
      metadata: expect.objectContaining({ reason: 'no_grant' }) as unknown
    });
  });

  it('lets the operator revoke a session and stops answering authz for it', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string }>();
    const revoked = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN }
    });
    expect(revoked.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
    const authz = await app.inject({
      method: 'GET', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }
    });
    expect(authz.json()).toEqual({ ok: false, reason: 'not_consumed' });
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json<{ items: Array<{ state: string }> }>().items).toEqual([
      expect.objectContaining({ alias: 'jarvis', mode: 'shell', state: 'closed' })
    ]);
  });

  it('records the close with its byte counters and reason', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { ticket: issued.ticket }
    });
    const closed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536 }
    });
    expect(closed.statusCode).toBe(204);
    const close = database.audit.find((row) => row.action === 'terminal.session.close');
    expect(close?.metadata).toMatchObject({
      close_reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
      image_id: 'sha256:c0ffee', generation: 'gen-7', operator_reason: 'revisar el harness colgado'
    });
    // Closing twice must not duplicate the audit row.
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { reason: 'again' }
    });
    expect(database.audit.filter((row) => row.action === 'terminal.session.close')).toHaveLength(1);
  });

  it('keeps the console security hook over the browser routes and off the relay routes', async () => {
    await report([presence()]);
    // A cross-origin POST from a browser is rejected before the plugin sees it.
    const crossOrigin = await openSession({}, { origin: 'https://evil.example' });
    expect(crossOrigin.statusCode).toBe(403);
    // The relay is not a browser and sends no Origin; its routes live outside /v3/console/.
    const relay = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { agents: [] }
    });
    expect(relay.statusCode).toBe(200);
  });

  /* ------------------------------------------------------------------ */
  /* GET /v3/console/agents/:tenant/:alias/directive                     */
  /* ------------------------------------------------------------------ */

  const CLAUDE = { facts: { harness: 'claude', home: '/home/dev' } as RuntimeFacts, source: 'measured' as FactsSource };
  const DIRECTIVA = '/v3/console/agents/Steven/jarvis/directive';
  const MANUAL = '/home/dev/.claude/CLAUDE.md';

  interface DirectiveBody {
    publicado: boolean;
    motivo?: string;
    files: Array<{ path: string; text: string | null; bytes: number | null; modified_at: string | null; truncated: boolean }> | null;
    memory: { root: string; entries: unknown[] } | null;
  }

  it('sirve el manual del sitio que el pty-agent devolvió', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<DirectiveBody>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({
      text: '# Manual\n', bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z'
    });
  });

  it('sólo le pide al relay el manual del sitio, nunca settings.json ni .claude.json', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    // Los cuatro documentos del alias salen en la respuesta: la ruta los recorrió todos. Sin esto,
    // un cambio que dejara la lista en un solo documento haría pasar la comprobación de abajo sin
    // que la puerta de lectura estuviera filtrando nada.
    const files = response.json<DirectiveBody>().files ?? [];
    expect(files.map((file) => file.path)).toEqual([
      MANUAL, '/home/dev/.claude/settings.json', '/home/dev/.claude/agents', '/home/dev/.claude.json'
    ]);
    expect(files.filter((file) => file.text !== null).map((file) => file.path)).toEqual([MANUAL]);
    // El juego cerrado de un alias claude tiene CUATRO documentos y la ruta los recorre todos; la
    // puerta de lectura (`verifyReadablePath`) deja pasar uno solo. `settings.json` lleva `hooks`,
    // que son órdenes de shell, y `.claude.json` lleva el OAuth de la cuenta: si algún día alguno
    // de los dos se cuela hasta el cable, esta lista lo enseña.
    expect(pedidas).toEqual([{ tenant_id: 'Steven', alias: 'jarvis', path: MANUAL }]);
  });

  it('marca el fichero como no disponible cuando la lectura falla, sin inventar texto', async () => {
    hechos.set('Steven:jarvis', CLAUDE);
    leer = () => ({ error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<DirectiveBody>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({ text: null, bytes: null, modified_at: null, truncated: false });
  });

  it('degrada con un motivo cuando nadie midió ese contenedor, y no molesta al relay', async () => {
    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const body = response.json<DirectiveBody>();
    expect(body).toMatchObject({ publicado: true, files: null, memory: null });
    expect(body.motivo).toContain('no medido');
    // Sin hechos no se sabe dónde vive el manual, así que preguntar sería pedir una ruta inventada.
    expect(pedidas).toEqual([]);
  });

  it('no sirve contenido cuando las rutas están deducidas del registro y no medidas', async () => {
    hechos.set('Steven:jarvis', { ...CLAUDE, source: 'database' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    const body = response.json<DirectiveBody>();
    expect(body.files).toBeNull();
    expect(body.motivo).toContain('no medidas');
    expect(pedidas).toEqual([]);
  });

  it('rechaza pedir la directiva de un alias nombrando otro inquilino', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Miguel/jarvis/directive' });

    // La ruta resuelve contra el inquilino del ACTOR, así que sin esta puerta la URL diría «Miguel»
    // y el cuerpo sería el manual de Steven:jarvis. Un identificador sin marco de referencia.
    expect(response.statusCode).toBe(403);
    expect(pedidas).toEqual([]);
  });

  it('exige el permiso de lectura de consola', async () => {
    await build({}, consoleAuthProvider({ permissions: ['route', 'control'] }));
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(403);
    expect(pedidas).toEqual([]);
  });

  it('contesta 401 —no 500— al que no está autenticado', async () => {
    await build({}, {
      name: 'test-sin-sesion', mode: 'test',
      authenticateHttp: async () => { throw new AuthError(); },
      authenticateHello: async () => { throw new AuthError(); }
    });
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    // La ruta de directiva no atrapa nada por dentro: sin el manejador de errores del ámbito, un
    // operador con la sesión caducada vería «error interno» y buscaría el fallo donde no está.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });
});

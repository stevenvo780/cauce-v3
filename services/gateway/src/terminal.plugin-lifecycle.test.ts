import type { AuthProvider } from './auth.js';
import { createHash, randomUUID } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RelayFileRead, RuntimeFacts } from './console/agent-documents.js';
import type { FactsSource, GovernanceReadError } from './console/agent-documents.routes.js';
import { createConsoleSecurityHook } from './console-security.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { AgentRegistry } from './terminal/registry.js';
import { UNATTRIBUTED_OPERATOR, type AgentPresence } from './terminal/types.js';
import { registerBrokenClientTest } from './test-support/terminal-plugin.js';
import {
  CLAIM_A,
  MASTER,
  ORIGIN,
  RELAY_A,
  RELAY_B,
  RELAY_BOOT_A,
  RELAY_TOKEN,
  consoleAuthProvider,
  installAuthorityCarrier,
  fakeDatabase,
  presence,
  type FakeDatabase,
} from './terminal.plugin.fixtures.js';

describe('terminal control plane', () => {
  let directory: string;
  let grantsFile: string;
  let database: FakeDatabase;
  let registry: AgentRegistry;
  let app: FastifyInstance;
  let config: TerminalConfig;
  let controlPermission: () => Promise<void>;
  /** MEASURED facts per alias. Empty = nobody measured that container, which is today's state. */
  let hechos: Map<string, { facts: RuntimeFacts; source: FactsSource }>;
  /** Everything the gateway asked the terminal-relay, in order. */
  let pedidas: { tenant_id: string; alias: string; path: string }[];
  let leer: (path: string) => RelayFileRead | GovernanceReadError;
  let relayPeerInstanceId: string;
  let relayBootId: string;

  async function build(overrides: Partial<TerminalConfig> = {}, provider: AuthProvider = consoleAuthProvider()): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The first beforeEach call reaches this helper before app is initialized at runtime.
    if (app !== undefined) await app.close();
    config = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: MASTER,
      relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([RELAY_A, RELAY_B]),
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set<string>(),
      ...overrides
    };
    app = Fastify({ logger: false });
    installAuthorityCarrier(app, database, provider);
    // app.inject has no TLS socket. This test harness supplies the independently authenticated
    // peer identity and envelopes legacy test calls exactly as the real relay client does.
    app.addHook('preValidation', async (request) => {
      if (!request.url.startsWith('/v3/terminal/relay/')) return;
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return;
      const body = request.body as Record<string, unknown>;
      body.relay_instance_id ??= relayPeerInstanceId;
      body.relay_boot_id ??= relayBootId;
    });
    // Same hook app.ts installs before the plugin; it must cover the console routes and must
    // NOT cover the relay routes, which is exactly why those live outside /v3/console/.
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [ORIGIN] }));
    await app.register(registerTerminalControlPlane, {
      pool: database.pool,
      authProvider: provider,
      config,
      registry,
      repository: {
        assertPermission: async () => { await controlPermission(); },
        authorizeAgentTarget: async (actorTenant, _actorAlias, targetTenant, targetAlias) => {
          const visible = targetTenant === actorTenant || database.edges.includes(`${actorTenant}->${targetTenant}`);
          const target = database.placements.find((row) =>
            row.tenant_id === targetTenant && row.alias === targetAlias);
          return !visible || !target ? undefined : {
            tenant_id: targetTenant,
            alias: targetAlias,
            harness_id: null,
            home_directory: null,
            enabled: true,
          };
        },
      },
      measuredFacts: { factsFor: async (tenantId, alias) => hechos.get(`${tenantId}:${alias}`) },
      // The terminal-relay is the only thing substituted: mounting the whole relay here would
      // test the relay, not the plugin. What is recorded is WHICH routes get asked for, which
      // is the part the gateway decides.
      governanceRelay: {
        readFile: async (tenantId, alias, path) => {
          pedidas.push({ tenant_id: tenantId, alias, path });
          return leer(path);
        }
      },
      relayPeerInstanceId: () => relayPeerInstanceId,
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

  async function grant(entries: { operator?: string; tenant_id: string; alias: string; modes: string[] }[]): Promise<void> {
    await writeFile(grantsFile, JSON.stringify({
      version: 1,
      grants: entries.flatMap((entry) => [UNATTRIBUTED_OPERATOR, 'steven'].map((operator) => ({ operator, ...entry })))
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
        reason: 'revisar el harness colgado', cols: 120, rows: 40,
        request_id: randomUUID(), owner_token: randomUUID(), ...body
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
      path, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z',
      sha: createHash('sha256').update('# Manual\n').digest('hex'), content: '# Manual\n'
    });
    relayPeerInstanceId = RELAY_A;
    relayBootId = RELAY_BOOT_A;
    await grant([{ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }]);
    await build();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  registerBrokenClientTest(() => ({ app, database, openSession, prepare: () => report([presence()]) }), ORIGIN);

  it('scopes unattributed quotas, listing and revocation to the authenticated console subject', async () => {
    await build({ maxSessionsPerOperator: 1 }, consoleAuthProvider({ alias: 'kant' }));
    await report([presence()]);
    const firstOwnerToken = randomUUID();
    const first = (await openSession({ owner_token: firstOwnerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const firstRow = database.sessions.get(first.session_id);
    expect(firstRow).toBeDefined();
    if (firstRow === undefined) return;
    // Keep it open for quota purposes but move the synthetic row away from jarvis' container so
    // this unit test isolates the per-subject operator scope from the global container lock.
    firstRow.container = 'detached-test-container';

    database.rooms['Steven:socrates'] = ['grp.steven'];
    await build({ maxSessionsPerOperator: 1 }, consoleAuthProvider({ alias: 'socrates' }));
    const hidden = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ items: [] });

    const forbiddenRevoke = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${first.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: first.request_id,
        owner_token: firstOwnerToken,
        owner_generation: first.owner_generation,
      },
    });
    expect(forbiddenRevoke.statusCode).toBe(403);
    expect(forbiddenRevoke.json()).toEqual({ error: 'forbidden', message: 'insufficient permissions' });
    expect(database.sessions.get(first.session_id)?.revoked_at).toBeNull();

    const independent = await openSession({ reason: 'tarea del segundo sujeto de consola' });
    expect(independent.statusCode).toBe(201);
    expect(database.sessions.size).toBe(2);
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json<{ items: { session_id: string }[] }>().items).toEqual([
      expect.objectContaining({ session_id: independent.json<{ session_id: string }>().session_id }),
    ]);
  });

  it('never lets bounded history hide an older session that still consumes an operator slot', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string }>();
    const active = database.sessions.get(issued.session_id);
    expect(active).toBeDefined();
    if (!active) return;

    // More than the endpoint limit, all newer but already closed. An issued_at-only LIMIT 100
    // drops the one row the operator needs in order to escape session_limit.
    for (let index = 0; index < 110; index += 1) {
      database.sessions.set(`closed-history-${String(index).padStart(3, '0')}`, {
        ...active,
        id: `closed-history-${String(index).padStart(3, '0')}`,
        issued_at: new Date(active.issued_at.getTime() + index + 1),
        revoked_at: null,
        closed_at: new Date(active.issued_at.getTime() + index + 1),
        close_reason: 'test_history',
      });
    }

    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    const items = listed.json<{ items: { session_id: string; state: string }[] }>().items;
    expect(items).toHaveLength(100);
    expect(items[0]).toMatchObject({ session_id: issued.session_id, state: 'issued' });
  });

  it('marks expiration with the database clock so the browser never decides whether a slot exists', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string }>();
    const row = database.sessions.get(issued.session_id);
    expect(row).toBeDefined();
    if (!row) return;
    row.expires_at = new Date(Date.now() - 1_000);

    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });

    expect(listed.json<{ items: { session_id: string; state: string }[] }>().items).toEqual([
      expect.objectContaining({ session_id: issued.session_id, state: 'closed' }),
    ]);
  });

  it('records the close with its byte counters and reason', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A }
    });
    const closed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
        claim_token: CLAIM_A, claim_epoch: '1',
      }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({
      ok: true,
      relay_instance_id: RELAY_A,
      relay_boot_id: RELAY_BOOT_A,
    });
    const close = database.audit.find((row) => row.action === 'terminal.session.close');
    expect(close?.metadata).toMatchObject({
      close_reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
      image_id: 'sha256:c0ffee', generation: 'gen-7', operator_reason: 'revisar el harness colgado'
    });
    // Closing twice must not duplicate the audit row.
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'again', exit_code: null, bytes_in: 0, bytes_out: 0,
        claim_token: CLAIM_A, claim_epoch: '1',
      }
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
});

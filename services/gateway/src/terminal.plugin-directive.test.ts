import { createHash, randomUUID } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { AuthError } from './auth.js';
import type { RelayFileRead, RuntimeFacts } from './console/agent-documents.js';
import type { FactsSource, GovernanceReadError } from './console/agent-documents.routes.js';
import type { AgentDirective } from './console/types-agent-directive.js';
import { createConsoleSecurityHook } from './console-security.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { AgentRegistry } from './terminal/registry.js';
import { UNATTRIBUTED_OPERATOR } from './terminal/types.js';
import {
  MASTER,
  ORIGIN,
  RELAY_A,
  RELAY_B,
  RELAY_BOOT_A,
  RELAY_TOKEN,
  consoleAuthProvider,
  fakeDatabase,
  type FakeDatabase,
} from './terminal.plugin.shared.js';

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

  async function build(overrides: Partial<TerminalConfig> = {}, provider = consoleAuthProvider()): Promise<void> {
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

  /* ------------------------------------------------------------------ */
  /* GET /v3/console/agents/:tenant/:alias/directive                     */
  /* ------------------------------------------------------------------ */

  const CLAUDE = { facts: { harness: 'claude', home: '/home/dev' } as RuntimeFacts, source: 'measured' as FactsSource };
  const DIRECTIVA = '/v3/console/agents/Steven/jarvis/directive';
  const MANUAL = '/home/dev/.claude/CLAUDE.md';

  it('sirve el manual del sitio que el pty-agent devolvió', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<AgentDirective>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({
      text: '# Manual\n', bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z'
    });
  });

  it('sirve directiva a un reader sin abrir targets ni sesiones PTY', async () => {
    await build({}, consoleAuthProvider({ roles: [], permissions: ['read'] }));
    hechos.set('Steven:jarvis', CLAUDE);

    const directive = await app.inject({ method: 'GET', url: DIRECTIVA });
    const targets = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    const session = await openSession({});

    expect(directive.statusCode).toBe(200);
    expect(directive.json<AgentDirective>().files).toEqual([
      expect.objectContaining({ path: MANUAL, text: '# Manual\n' }),
    ]);
    expect(targets.statusCode).toBe(403);
    expect(session.statusCode).toBe(403);
    expect(database.sessions.size).toBe(0);
  });

  it('sólo le pide al relay el manual del sitio, nunca settings.json ni .claude.json', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    const files = response.json<AgentDirective>().files ?? [];
    expect(files.map((file) => file.path)).toEqual([MANUAL]);
    expect(files.filter((file) => file.text !== null).map((file) => file.path)).toEqual([MANUAL]);
    expect(pedidas).toEqual([{ tenant_id: 'Steven', alias: 'jarvis', path: MANUAL }]);
  });

  it('marca el fichero como no disponible cuando la lectura falla, sin inventar texto', async () => {
    hechos.set('Steven:jarvis', CLAUDE);
    leer = () => ({ error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<AgentDirective>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({ text: null, bytes: null, modified_at: null, truncated: false });
  });

  it('degrada con un motivo cuando nadie midió ese contenedor, y no molesta al relay', async () => {
    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body).toMatchObject({
      publicado: true,
      medido: false,
      files: null,
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'contenedor no medido todavía (sin hechos de entorno)',
      },
    });
    expect(body.motivo).toContain('no medido');
//    Without facts, where the manual lives is unknown, so asking would be asking for an invented path.
    expect(pedidas).toEqual([]);
  });

  it('no sirve contenido cuando las rutas están deducidas del registro y no medidas', async () => {
    hechos.set('Steven:jarvis', { ...CLAUDE, source: 'database' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    const body = response.json<AgentDirective>();
    expect(body.files).toBeNull();
    expect(body.motivo).toContain('no medidas');
    expect(pedidas).toEqual([]);
  });

  it('no confunde un alias del tenant propio con el mismo nombre pedido bajo otro tenant', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Miguel/jarvis/directive' });

//    Miguel:jarvis does not exist. Identity is the exact pair; it never falls through by alias to Steven:jarvis.
    expect(response.statusCode).toBe(404);
    expect(pedidas).toEqual([]);
  });

  it('sirve la directiva cross-tenant cuando la misma ACL allow_read que muestra la flota la autoriza', async () => {
    hechos.set('Miguel:atlas', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Miguel/atlas/directive' });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentDirective>()).toMatchObject({ publicado: true, medido: true });
    expect(pedidas).toEqual([{ tenant_id: 'Miguel', alias: 'atlas', path: MANUAL }]);
  });

  it('no revela una directiva cross-tenant sin ACL allow_read', async () => {
    hechos.set('Pablo:dedalo', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Pablo/dedalo/directive' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
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

//    The directive route does not catch anything internally: without the scope error handler, an
    // operator with an expired session would see "internal error" and look for the fault where it is not.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });
});

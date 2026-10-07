import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../../services/gateway/src/index.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { configuredHumanMcp } from '../../services/gateway/src/mcp-configuration.js';
import { OAuthClients } from '../../services/gateway/src/oauth-client-metadata.js';
import { concreteSegments, extractClientCalls } from './console-route-helper.js';
import type { OAuthAuthorizationServerOptions } from '../../services/gateway/src/oauth-authorization-server.js';
import { FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal } from './helpers.js';

/**
 * Contract guard for the console -> gateway API surface.
 *
 * Regression origin: the console shipped `getTopologyAccess()` against
 * `/v3/console/topology/access`, a route the gateway never registered. The MSW development
 * mock defined that route, so every console test passed while production answered 404 and the
 * Ultimate Terminal composer stayed disabled.
 *
 * These tests fail if the console (or its mock) ever again names a gateway route that
 * `buildGateway` does not serve.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface ApiCall {
  readonly method: HttpMethod;
  readonly path: string;
}

const CLIENT_PATH = fileURLToPath(new URL('../../console/src/api/client.ts', import.meta.url));
/* The routes left `client.ts`, which now only forwards: reading it alone verifies ZERO and passes. */
const CLIENT_MODULES_DIR = fileURLToPath(new URL('../../console/src/api/client/', import.meta.url));
const HANDLERS_PATH = fileURLToPath(new URL('../../console/src/mocks/handlers.ts', import.meta.url));

/**
 * Routes registered only when the gateway runs with an OIDC BFF auth provider. The console
 * tolerates their 404 on purpose (it flips `bffSessionSupported` off and falls back to non-BFF
 * auth), so they are the only legitimate exemptions. The final test proves this exemption is
 * real rather than a rubber stamp.
 */
const OIDC_BFF_ONLY = new Set(['/v3/auth/session', '/v3/auth/logout']);

/**
 * Routes that only exist when the gateway starts WITH the terminal control plane.
 *
 * `registerTerminalControlPlane` needs its own configuration (relay token, governance URL) and
 * `operatorGateway()` does not supply it, so these two are not mounted in this test's gateway —
 * and that is not a defect: in production they ARE mounted, hung off that plugin.
 *
 * They are declared EXPLICITLY instead of being left in the failure list because a test that
 * has been red for months for known reasons stops being read, and then the NEW failure (the one
 * that matters) slips in unnoticed. Their presence here is the assertion that each one was
 * looked at.
 */
const SOLO_CON_PLANO_DE_TERMINAL = new Set([
  '/v3/console/agents/1/1/directive',
  '/v3/console/terminal/sessions'
]);

const CLIENT_DECLARATIONS = [
  { method: 'GET', path: '/v3/console/mcp/client-delegations' },
  { method: 'POST', path: '/v3/console/mcp/client-delegations' },
  { method: 'POST', path: '/v3/console/mcp/client-delegations/1/rename' },
  { method: 'POST', path: '/v3/console/mcp/client-delegations/1/revoke' },
] as const satisfies readonly ApiCall[];
const LOCAL_OAUTH_ONLY = new Set(CLIENT_DECLARATIONS.map(call => `${call.method} ${call.path}`));
const declarationRoutePattern = (call: ApiCall) => call.path.replace('/1/', '/:binding_id/');

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/** Extracts every gateway route the MSW development mock pretends to serve. */
function extractMockCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const pattern = /http\.([a-z]+)\(\s*'([^']+)'/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const method = (match[1] ?? '').toUpperCase();
    const rawPath = (match[2] ?? '').replace(/^\*/, '');
    if (!isHttpMethod(method)) throw new Error(`unsupported HTTP method in handlers.ts: ${method}`);
    if (!rawPath.startsWith('/v3/')) continue;
    calls.push({ method, path: concreteSegments(rawPath) });
  }
  return calls;
}

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(fixtureDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function operatorGateway() {
  const pool = fakePool();
  const repository = fakeRepository();
  const authProvider = new FixedAuthProvider(testPrincipal({
    roles: roles('operator'), permissions: grants('route', 'read', 'control'),
  }));
  const app = await buildGateway({
    pool, repository, authProvider,
    deliveryWakeSubscriber: noDeliveryWakes, outboxPollMs: 60_000,
  });
  apps.push(app);
  const directory = await mkdtemp(join(tmpdir(), 'cauce-route-contract-'));
  fixtureDirectories.push(directory);
  const grantsFile = join(directory, 'grants.json');
  await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
  await registerTerminalControlPlane(app, { pool, authProvider, repository,
    config: { wsPath: '/v3/console/terminal/ws', ticketKey: Buffer.alloc(32),
      relayToken: 'routing-contract', relayInstanceIds: new Set(), grantsFile,
      ticketTtlSeconds: 30, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set(),
    },
    governanceRelay: { readFile: async () => { throw new Error('Route fixture must not contact a relay'); } },
  });
  return app;
}

function clientDeclarationConfiguration() {
  const provider = new PasswordAuthProvider({ signingKey: Buffer.alloc(32), users: {
    ready: async () => undefined, findByEmail: async () => undefined,
    findById: async () => undefined, updateDisplayName: async () => undefined, recordLogin: async () => undefined,
  } });
  const external = configuredHumanMcp({
    CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test',
    CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example.test',
    CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/jwks',
  });
  if (!external) throw new Error('Missing MCP fixture');
  const unexpected = () => { throw new Error('Routing fixture must not issue or resolve OAuth grants'); };
  const clients = new OAuthClients();
  vi.spyOn(clients, 'resolve').mockImplementation(unexpected);
  const oauth: OAuthAuthorizationServerOptions = {
    passwordAuth: provider, clients, session: async () => unexpected(),
    tokens: { issuer: 'https://mcp.example.test', resource: 'https://mcp.example.test/mcp',
      issue: unexpected, jwks: unexpected } as unknown as OAuthAuthorizationServerOptions['tokens'],
    store: new Proxy({}, { get: unexpected }) as OAuthAuthorizationServerOptions['store'],
  };
  const local = configuredHumanMcp({ CAUCE_MCP_OAUTH_PROVIDER: 'local',
    CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test' }, oauth);
  if (!local) throw new Error('Missing local OAuth fixture');
  return { provider, external, local };
}

async function clientDeclarationGateway(mode: 'off' | 'external' | 'local') {
  const configuration = clientDeclarationConfiguration();
  const pool = fakePool();
  const app = await buildGateway({ pool, repository: fakeRepository(), authProvider: configuration.provider,
    ...(mode === 'off' ? {} : { humanMcp: configuration[mode] }),
    deliveryWakeSubscriber: noDeliveryWakes, outboxPollMs: 60_000 });
  apps.push(app);
  return { app, pool };
}

async function unroutedPaths(calls: readonly ApiCall[]): Promise<string[]> {
  const app = await operatorGateway();
  const missing: string[] = [];
  for (const call of calls) {
    if (OIDC_BFF_ONLY.has(call.path)) continue;
    if (SOLO_CON_PLANO_DE_TERMINAL.has(call.path)) continue;
    if (LOCAL_OAUTH_ONLY.has(`${call.method} ${call.path}`)) continue;
    const response = await app.inject({
      method: call.method,
      url: call.path,
      ...(call.method === 'GET' ? {} : { payload: {} })
    });
    // Router absence must stay distinct from an explicit handler's resource-not-found response.
    if (response.statusCode !== 404) continue;
    const cuerpo = response.json<{ error?: string; message?: string }>();
    const routerNotFound = cuerpo.error === 'Not Found'
      && cuerpo.message === `Route ${call.method}:${call.path} not found`;
    if (cuerpo.error !== undefined && !routerNotFound) continue;
    missing.push(`${call.method} ${call.path}`);
  }
  return missing;
}

describe('console API surface matches the gateway routing table', () => {
  it('serves every route the console client requests', async () => {
    const modulos = (await readdir(CLIENT_MODULES_DIR))
      .filter((nombre) => nombre.endsWith('.ts') && !nombre.includes('.test.'))
      .map((nombre) => `${CLIENT_MODULES_DIR}${nombre}`);
    const fuentes = await Promise.all([CLIENT_PATH, ...modulos].map((ruta) => readFile(ruta, 'utf8')));
    const calls = fuentes.flatMap((fuente) => extractClientCalls(fuente));
    expect(calls.length, 'el extractor no encontro ninguna ruta: estaria verificando nada').toBeGreaterThan(20);

    // Guards the parser itself: a silently empty extraction would make this suite vacuous.
    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/topology' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/agents/1/1/directive' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/documents' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/perfil' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/context/repository' });
    expect(calls).toContainEqual({ method: 'POST', path: '/v3/console/tenants/1/agents/1/context/repository/preview' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/context/repository/inspect?1' });
    for (const call of CLIENT_DECLARATIONS) expect(calls).toContainEqual(call);
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/agent-preferences' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/perfil/revisions?1' });
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/tenants/1/agents/1/documents/1/revisions?1' });
    expect(calls).toContainEqual({ method: 'PUT', path: '/v3/console/favorites/1/1' });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v3/console/favorites/1/1' });
    expect(calls).toContainEqual({ method: 'PUT', path: '/v3/console/agents/1/1/appearance' });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v3/console/agents/1/1/appearance?expected_revision=1' });
    expect(calls.map((call) => call.path)).not.toContain('/v3/console/topology/access');

    expect(await unroutedPaths(calls)).toEqual([]);
  });

  it.each([
    'request(unknownRoute(tenantId, alias));',
    'request(`${unknownRoute(tenantId, alias)}/preview`, { method: \'POST\' });',
  ])('rejects an unresolved helper instead of omitting its route: %s', (source) => {
    expect(() => extractClientCalls(source)).toThrow('el extractor no supo sacar la ruta');
  });

  it('serves every route the MSW development mock declares', async () => {
    const calls = extractMockCalls(await readFile(HANDLERS_PATH, 'utf8'));

    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(await unroutedPaths(calls)).toEqual([]);
  });

  it('confirms the OIDC-only exemptions are genuinely absent without a BFF provider', async () => {
    const app = await operatorGateway();

    for (const path of OIDC_BFF_ONLY) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, `${path} should be OIDC-conditional`).toBe(404);
    }
  });

  it('mounts every declaration route with the real password provider and local OAuth, and denies anonymous access without writes', async () => {
    const { app, pool } = await clientDeclarationGateway('local');
    const query = vi.spyOn(pool, 'query');
    const before = query.mock.calls.length;
    for (const call of CLIENT_DECLARATIONS) {
      expect(app.hasRoute({ method: call.method, url: declarationRoutePattern(call) }), `${call.method} ${call.path}`).toBe(true);
      const response = await app.inject({ method: call.method, url: call.path,
        headers: { origin: 'http://localhost' },
        ...(call.method === 'POST' ? { payload: {} } : {}) });
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(query.mock.calls.length).toBe(before);
  });

  it.each(['off', 'external'] as const)('keeps declaration routes absent with password authentication and MCP %s', async mode => {
    const { app } = await clientDeclarationGateway(mode);
    for (const call of CLIENT_DECLARATIONS) expect(app.hasRoute({ method: call.method, url: declarationRoutePattern(call) })).toBe(false);
  });

  it('keeps declaration routes absent for fixed auth and rejects local OAuth with a mismatched password provider', async () => {
    const app = await operatorGateway();
    for (const call of CLIENT_DECLARATIONS) expect(app.hasRoute({ method: call.method, url: declarationRoutePattern(call) })).toBe(false);
    const { local } = clientDeclarationConfiguration();
    await expect(buildGateway({ pool: fakePool(), repository: fakeRepository(),
      authProvider: new FixedAuthProvider(testPrincipal()), humanMcp: local,
      deliveryWakeSubscriber: noDeliveryWakes })).rejects.toThrow('Local OAuth requires the configured password provider');
  });
});



describe('console route absence discrimination', () => {
  it('keeps explicit handler not_found responses out of the missing-route list', async () => {
    const call = { method: 'GET', path: '/v3/console/tenants/Steven/agents/absent/documents' } as const;
    const app = await operatorGateway();
    const response = await app.inject({ method: call.method, url: call.path });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('not_found');
    expect(await unroutedPaths([call])).toEqual([]);
  });

  it('detects an unregistered mutated helper suffix through the real gateway router', async () => {
    const source = "function route(prefix: string, suffix: string) { return `${prefix}/${suffix}`; }"
      + "request(route('/v3/console/agents/1/1', 'not-registered'));";
    const calls = extractClientCalls(source);
    expect(calls).toEqual([{ method: 'GET', path: '/v3/console/agents/1/1/not-registered' }]);
    const app = await operatorGateway();
    const path = '/v3/console/agents/1/1/not-registered';
    expect(app.hasRoute({ method: 'GET', url: path })).toBe(false);
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not Found', statusCode: 404, message: `Route GET:${path} not found` });
    expect(await unroutedPaths(calls)).toEqual(['GET /v3/console/agents/1/1/not-registered']);
  });
});

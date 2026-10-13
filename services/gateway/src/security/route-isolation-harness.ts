import { channel } from 'node:diagnostics_channel';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { CauceRepository, FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { JwksJwtAuthProvider, MtlsAuthProvider } from '../auth.js';
import { OidcBffAuthProvider, PostgresOidcSessionStore } from '../oidc-bff.js';
import { OAuthClients } from '../oauth-client-metadata.js';
import { PostgresOAuthStore } from '../oauth-authorization-store.js';
import { OAuthTokens } from '../oauth-tokens.js';
import { registerOAuthAuthorizationServer } from '../oauth-authorization-server.js';
import { createOAuthPasswordSession } from '../oauth-password-session.js';
import { registerClientDelegationRoutes } from '../routes/mcp-client-delegations.js';
import { FleetMtlsIdentityProvider } from '../fleet/mtls-identities.js';
import { SignedFleetAuthorityClient } from '../fleet/authority/signed-client.js';
import { createLegacyFleetAdoptionService } from '../fleet/adoption.js';
import { HostLegacyAdoptionProbe } from '../fleet/adoption-bridge-client.js';
import { buildLoopbackHealthProbe } from '../health.js';
import { WakePumpTelemetry } from '../wake-pump-telemetry.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { ROUTE_ISOLATION_MATRIX, type RouteIsolationEntry } from './route-isolation-matrix.js';
import { seedIsolationFixtures, type IsolationCompany } from './route-isolation-fixtures.js';
import { mountIsolationTerminal } from './route-isolation-sockets.js';
import type { RouteIsolationMethod } from './route-isolation-matrix.js';
import { providerAuthService } from './route-isolation-provider.js';
import { validateCanaryFixtures } from './route-isolation-canary.js';

export interface RegisteredRoute { method: string; url: string }
export interface IsolationResponse { status: number; body: string; headers: Record<string, string | string[] | undefined> }
export type IsolationSession = Record<'cookie' | 'origin' | 'x-csrf-token', string>;
export function routeKey(method: string, url: string): string { return `${method === 'HEAD' ? 'GET' : method} ${url}`; }

export function assertRouteCoverage(routes: readonly RegisteredRoute[]): void {
  const declared = new Map(ROUTE_ISOLATION_MATRIX.map(entry => [routeKey(entry.method, entry.url), entry]));
  if (declared.size !== ROUTE_ISOLATION_MATRIX.length) throw new Error('duplicate matrix entries');
  const missing = routes.filter(route => !declared.has(routeKey(route.method, route.url)));
  if (missing.length) throw new Error(`uncovered routes: ${[...new Set(missing.map(route => routeKey(route.method, route.url)))].join(', ')}`);
  const registered = new Set(routes.map(route => routeKey(route.method, route.url)));
  const unregistered = ROUTE_ISOLATION_MATRIX.filter(entry => entry.kind !== 'websocket' && !registered.has(routeKey(entry.method, entry.url)));
  if (unregistered.length) throw new Error(`unregistered matrix routes: ${unregistered.map(entry => routeKey(entry.method, entry.url)).join(', ')}`);
  for (const route of routes) {
    const entry = declared.get(routeKey(route.method, route.url));
    if (!entry?.reason) throw new Error(`route requires an explicit reason: ${routeKey(route.method, route.url)}`);
    if (entry.kind === 'scoped' && !entry.probe) throw new Error(`scoped route requires an adversarial probe: ${entry.url}`);
  }
}

export function expandProbe(entry: RouteIsolationEntry, fixture: IsolationCompany, own: IsolationCompany): { url: string; payload?: unknown } {
  const values: Record<string, unknown> = { ...fixture, director: fixture.alias, tenantId: fixture.tenant,
    ownRoom: own.room, ownTenant: own.tenant, ownAlias: own.ownerAlias };
  const expand = (text: string): string => text.replace(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`missing real fixture ${name} for ${entry.method} ${entry.url}`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`non-scalar path fixture ${name}`);
    return String(value);
  });
  const probe = entry.probe;
  if (!probe) return { url: entry.url };
  const expandPayload = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = /^\{(\w+)\}$/u.exec(value)?.[1];
      if (exact !== undefined) {
        if (values[exact] === undefined) throw new Error(`missing real fixture ${exact} for ${entry.url}`);
        return values[exact];
      }
      return expand(value);
    }
    if (Array.isArray(value)) return value.map(expandPayload);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expandPayload(field)]));
    return value;
  };
  return { url: expand(probe.url), ...(probe.payload === undefined ? {} : { payload: expandPayload(probe.payload) }) };
}

export class IsolationHarness {
  app: FastifyInstance | undefined;
  database: TestDatabase | undefined;
  current: EmptyTestDatabase | undefined;
  directory: string | undefined;
  snapshotPool!: DatabasePool;
  externalPool: DatabasePool | undefined;
  fixtures!: { a: IsolationCompany; b: IsolationCompany };
  routes: RegisteredRoute[] = [];
  catalogRoutes: RegisteredRoute[] = [];
  baseUrl = process.env.CAUCE_ISOLATION_BASE_URL;
  terminalCleanup: (() => Promise<void>) | undefined;

  async start(): Promise<void> {
    this.database = await startTestDatabase();
    this.current = await startTestCaseDatabase(this.database);
    const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    this.directory = await mkdtemp(join(projectRoot, '.delegados/v4/route-isolation-'));
    const localFixtures = await seedIsolationFixtures(this.current, this.directory);
    this.fixtures = localFixtures;
    this.snapshotPool = this.current.adminPool;
    const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(this.current.pool), signingKey: Buffer.alloc(32, 47) });
    const origin = this.baseUrl === undefined ? 'http://localhost' : new URL(this.baseUrl).origin;
    const initialization = channel('fastify.initialization');
    const listener = (value: unknown) => {
      const { fastify } = value as { fastify: FastifyInstance };
      fastify.addHook('onRoute', route => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) this.routes.push({ method, url: route.url });
      });
    };
    initialization.subscribe(listener);
    try {
      const app = await buildGateway({ pool: this.current.pool, repository: new CauceRepository(this.current.pool), authProvider: provider,
        consoleOrigins: [origin], logger: false, exposeHealthRoutes: true,
        providerAuthService: providerAuthService(this.current.pool),
        terminalCapability: { available: true, ws_path: '/v3/console/terminal/ws', modes: ['shell', 'harness', 'harness_rw'] },
        contextRepository: { instance_id: 'isolation', repositoryPath: localFixtures.a.contextRepositoryPath },
        fleetOperationsRepository: new FleetOperationsRepository(this.current.pool),
        spaceBackups: { directory: this.directory, projectRoot, python: '/usr/bin/python3' },
        blobs: { directory: join(this.directory, 'blobs'), maxBytes: 1_048_576 } });
      this.app = app;
      const terminal = await mountIsolationTerminal(app, this.current.pool, provider, origin, localFixtures);
      this.terminalCleanup = terminal.cleanup;
      if (process.env.CAUCE_ISOLATION_UNCOVERED_ROUTE === '1') app.get('/v3/zz-uncovered-isolation-probe', async () => ({ ok: true }));
      await app.ready();
    } finally { initialization.unsubscribe(listener); }
    await this.collectCatalogRoutes(provider);
    if (this.baseUrl !== undefined) {
      const fixtureFile = process.env.CAUCE_ISOLATION_FIXTURE_FILE;
      const databaseUrl = process.env.CAUCE_ISOLATION_CANARY_DATABASE_URL;
      if (!fixtureFile || !databaseUrl) throw new Error('external mode requires a canary fixture file and a read-only canary database URL');
      this.fixtures = JSON.parse(await readFile(fixtureFile, 'utf8')) as { a: IsolationCompany; b: IsolationCompany };
      this.externalPool = new Pool({ connectionString: databaseUrl, max: 2, options: '-c default_transaction_read_only=on' });
      this.snapshotPool = this.externalPool;
      const validation = await validateCanaryFixtures(this.snapshotPool, this.fixtures);
      console.info(`ISOLATION_CANARY_VALIDATION=${JSON.stringify(validation)}`);
    }
  }

  private async collectCatalogRoutes(provider: PasswordAuthProvider): Promise<void> {
    if (!this.current || !this.directory) throw new Error('local isolation database unavailable');
    const pool = this.current.pool;
    const directory = this.directory;
    this.catalogRoutes = [...this.routes];
    const initialization = channel('fastify.initialization');
    const listener = (value: unknown) => {
      const { fastify } = value as { fastify: FastifyInstance };
      fastify.addHook('onRoute', route => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) this.catalogRoutes.push({ method, url: route.url });
      });
    };
    const apps: FastifyInstance[] = [];
    const issuer = 'https://isolation.example.test';
    const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'isolation',
      signingKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
    const store = new PostgresOAuthStore(pool, issuer, provider.verifyCredentialStamp.bind(provider));
    const bootstrapProvider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
      join(directory, 'base-identities.json'), join(directory, 'fleet-identities.json'), namespace));
    initialization.subscribe(listener);
    try {
      const optional = await buildGateway({ pool, authProvider: provider, logger: false,
        fleetOperationsRepository: new FleetOperationsRepository(pool),
        bootstrapProviders: { bootstrap: bootstrapProvider('bootstrap'), normal: bootstrapProvider('normal') },
        signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(directory, 'authority.sock'), { ownerUid: 0, peerUid: 0 }),
        legacyFleetAdoptionService: createLegacyFleetAdoptionService(pool, new HostLegacyAdoptionProbe(join(directory, 'adoption.sock'))) });
      apps.push(optional);
      await registerOAuthAuthorizationServer(optional, { tokens, store, clients: new OAuthClients(), passwordAuth: provider,
        session: createOAuthPasswordSession({ provider }) });
      registerClientDelegationRoutes(optional, pool, provider, { issuer, resource: tokens.resource,
        verifyCredentialStamp: provider.verifyCredentialStamp.bind(provider) });
      const oidc = new OidcBffAuthProvider({ issuer, jwksUrl: `${issuer}/jwks`, clientId: 'isolation',
        authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, redirectUri: `${issuer}/v3/auth/callback`,
        bearerProvider: new JwksJwtAuthProvider({ issuer, audience: 'isolation', jwksUrl: `${issuer}/jwks` }),
        sessionStore: new PostgresOidcSessionStore(pool, Buffer.alloc(32, 43)) });
      apps.push(await buildGateway({ pool, authProvider: oidc, logger: false }));
      apps.push(await buildLoopbackHealthProbe({ pool, wakePumpTelemetry: new WakePumpTelemetry() }));
      await Promise.all(apps.map(app => app.ready()));
    } finally {
      initialization.unsubscribe(listener);
      await Promise.all(apps.map(app => app.close()));
    }
  }

  async request(method: string, url: string, headers: Record<string, string> = {}, payload?: unknown): Promise<IsolationResponse> {
    if (this.baseUrl === undefined) {
      if (!this.app) throw new Error('isolation gateway unavailable');
      const result = await this.app.inject({ method: method as RouteIsolationMethod, url,
        headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
      return { status: result.statusCode, body: result.body, headers: { 'set-cookie': result.headers['set-cookie'] } };
    }
    const result = await fetch(new URL(url, this.baseUrl), { method, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: result.status, body: await result.text(), headers: { 'set-cookie': result.headers.getSetCookie() } };
  }

  async login(fixture: IsolationCompany): Promise<IsolationSession> {
    const origin = this.baseUrl === undefined ? 'http://localhost' : new URL(this.baseUrl).origin;
    const login = await this.request('POST', '/v3/auth/login', { origin }, { email: fixture.email, password: fixture.password });
    if (login.status !== 200) throw new Error(`canary owner login failed (${String(login.status)})`);
    const header = login.headers['set-cookie'];
    const cookies = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]);
    if (!cookies.length) throw new Error('canary owner has no signed session cookie');
    const body = JSON.parse(login.body) as { csrf_token: string };
    return { cookie: cookies.join('; '), origin, 'x-csrf-token': body.csrf_token };
  }

  async websocketUrl(): Promise<string> {
    if (this.baseUrl !== undefined) return this.baseUrl;
    if (!this.app) throw new Error('isolation gateway unavailable');
    return await this.app.listen({ host: '127.0.0.1', port: 0 });
  }

  async close(): Promise<void> {
    await this.app?.close();
    await this.terminalCleanup?.();
    await this.externalPool?.end();
    await this.current?.close();
    if (this.database) { await this.database.pool.end(); await this.database.container.stop(); }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

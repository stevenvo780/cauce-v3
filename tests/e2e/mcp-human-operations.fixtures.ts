import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { startTestDatabase, resetTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import type { VerifiedOAuthIdentity } from '../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import type { ExternalSubjectResolver } from '../../services/gateway/src/human-mcp-authority.js';

const execute = promisify(execFile);
const TEST_PASSWORD = 'mcp-human-test-password-never-used-for-login';
const TENANTS = ['Steven', 'Steven', 'Isa'] as const;
const ALIAS = 'mcpoperator';
const SUBJECTS = ['issuer-subject-steven-a', 'issuer-subject-steven-b', 'issuer-subject-isa'] as const;

export interface HumanAccount {
  readonly id: string;
  readonly tenant: typeof TENANTS[number];
  readonly alias: typeof ALIAS;
  readonly subject: typeof SUBJECTS[number];
}

export interface OAuthIssuerFixture {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly ca: Buffer;
  readonly tlsKey: Buffer;
  readonly tlsCertificate: Buffer;
  readonly jwks: readonly JsonWebKey[];
  issue(subject: string, scopes: readonly string[], audience: string,
    overrides?: Readonly<Record<string, unknown>>): Promise<string>;
  close(): Promise<void>;
}

export interface HumanOperationsFixture {
  readonly database: TestDatabase;
  readonly pool: DatabasePool;
  readonly repository: CauceRepository;
  readonly users: PostgresConsoleUserStore;
  readonly issuer: OAuthIssuerFixture;
  readonly accounts: readonly [HumanAccount, HumanAccount, HumanAccount];
  readonly subjectBindings: Map<string, { userId: string; status: 'active' | 'inactive' | 'revoked' }>;
  close(): Promise<void>;
}

export interface HttpsForwarder {
  readonly origin: string;
  setTarget(port: number): void;
  close(): Promise<void>;
}

export interface HumanMcpClient {
  listTools(): Promise<{ tools: readonly { name: string; inputSchema: unknown }[] }>;
  callTool(params: { name: string; arguments: Readonly<Record<string, unknown>> }): Promise<{
    isError?: boolean; content: readonly { type: string; text?: string }[]; structuredContent?: unknown;
  }>;
  close(): Promise<void>;
}

type SdkClientConstructor = new (clientInfo: { name: string; version: string })
  => HumanMcpClient & { connect(transport: object): Promise<void> };

type StreamableTransportConstructor = new (url: URL, options: { requestInit: { headers: { authorization: string } } })
  => object;

const mcpPackageRequire = createRequire(new URL('../../packages/mcp-fleet-monitor/package.json', import.meta.url));

export async function connectSdkClient(origin: string, token: string): Promise<HumanMcpClient> {
  const sdk = mcpPackageRequire('@modelcontextprotocol/sdk/client/index.js') as unknown as { Client: SdkClientConstructor };
  const streamable = mcpPackageRequire('@modelcontextprotocol/sdk/client/streamableHttp.js') as unknown as {
    StreamableHTTPClientTransport: StreamableTransportConstructor;
  };
  const client = new sdk.Client({ name: 'cauce-human-operations-e2e', version: '1.0.0' });
  const transport = new streamable.StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function listen(server: HttpServer | HttpsServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('listener address unavailable'));
      else resolve(address.port);
    });
  });
}

function close(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

export async function listenMcpHttpServer(server: HttpServer): Promise<number> {
  return listen(server);
}

export async function closeMcpHttpServer(server: HttpServer): Promise<void> {
  await close(server);
}

async function makeCertificate(directory: string): Promise<{ ca: Buffer; key: Buffer; certificate: Buffer }> {
  const run = async (args: string[]): Promise<void> => {
    try { await execute('openssl', args, { cwd: directory, timeout: 30_000, maxBuffer: 64 * 1024 }); }
    catch { throw new Error('MCP E2E ephemeral TLS certificate generation failed'); }
  };
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-subj', '/CN=cauce-mcp-e2e-ca', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(join(directory, 'server.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
      + 'subjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  await run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '11',
    '-days', '1', '-extfile', 'server.ext', '-out', 'server.pem']);
  await chmod(join(directory, 'ca.key'), 0o600);
  await chmod(join(directory, 'server.key'), 0o600);
  return { ca: await readFile(join(directory, 'ca.pem')), key: await readFile(join(directory, 'server.key')),
    certificate: await readFile(join(directory, 'server.pem')) };
}

async function assertOwnDatabaseBoundary(): Promise<void> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined || process.env.DOCKER_CONTEXT !== undefined
      || (process.env.DOCKER_HOST !== undefined && !process.env.DOCKER_HOST.startsWith('unix://'))) {
    throw new Error('MCP E2E requires a disposable database on the local Docker daemon');
  }
  if (process.env.DOCKER_HOST === undefined) {
    const { stdout: context } = await execute('docker', ['context', 'show'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const { stdout: endpoint } = await execute('docker', ['context', 'inspect', context.trim(),
      '--format', '{{.Endpoints.docker.Host}}'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    if (!endpoint.trim().startsWith('unix://')) throw new Error('MCP E2E refuses a non-local Docker context');
  }
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const owner = process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER;
  if (network === undefined) {
    if (owner !== undefined) throw new Error('MCP E2E network owner requires an explicit network');
    return;
  }
  if (!network || !owner || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)) {
    throw new Error('MCP E2E network requires a UUIDv4 owner');
  }
  try {
    const { stdout } = await execute('docker', ['network', 'inspect', '--format', '{{json .}}', '--', network],
      { timeout: 5_000, maxBuffer: 64 * 1024 });
    const value: unknown = JSON.parse(stdout);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const info = value as Record<string, unknown>;
    const labels = info.Labels;
    if (info.Name !== network || info.Driver !== 'bridge' || info.Scope !== 'local' || info.Internal !== false
        || labels === null || typeof labels !== 'object' || Array.isArray(labels)
        || (labels as Record<string, unknown>)['cauce.test.owner'] !== owner) throw new Error();
  } catch { throw new Error('MCP E2E could not verify its exact owned Docker network'); }
}

export async function startOAuthIssuer(
  directory: string, material?: { ca: Buffer; key: Buffer; certificate: Buffer },
): Promise<OAuthIssuerFixture> {
  const tlsMaterial = material ?? await makeCertificate(directory);
  const generated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = generated.publicKey.export({ format: 'jwk' });
  const privateKey = createPrivateKey(generated.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const kid = randomUUID();
  const jwks = Object.freeze([{ ...publicKey, kid, alg: 'RS256', use: 'sig' }]);
  const server = createHttpsServer({ key: tlsMaterial.key, cert: tlsMaterial.certificate }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/.well-known/jwks.json') {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ keys: jwks }));
  });
  const port = await listen(server);
  const issuer = `https://localhost:${String(port)}`;
  return {
    issuer, jwksUri: `${issuer}/.well-known/jwks.json`, ca: tlsMaterial.ca,
    tlsKey: tlsMaterial.key, tlsCertificate: tlsMaterial.certificate, jwks,
    async issue(subject, scopes, audience, overrides = {}) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid })).toString('base64url');
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: issuedAt,
        exp: issuedAt + 300, scope: scopes.join(' '), ...overrides })).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
      return `${signingInput}.${signature}`;
    },
    async close() { await close(server); },
  };
}

export async function trustFixtureCa(ca: Buffer): Promise<() => void> {
  const tls = await import('node:tls');
  const previous = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...previous, ca.toString('utf8')]);
  return () => { tls.setDefaultCACertificates(previous); };
}

export async function startHumanOperationsFixture(): Promise<HumanOperationsFixture> {
  await assertOwnDatabaseBoundary();
  const database = await startTestDatabase();
  let issuer: OAuthIssuerFixture | undefined;
  let directory: string | undefined;
  try {
    await resetTestDatabase(database.pool);
    directory = await mkdtemp(join(tmpdir(), 'cauce-mcp-human-'));
    await chmod(directory, 0o700);
    issuer = await startOAuthIssuer(directory);
    const users = new PostgresConsoleUserStore(database.pool);
    await users.ready();
    const accounts: [HumanAccount, HumanAccount, HumanAccount] = [
      { id: randomUUID(), tenant: TENANTS[0], alias: ALIAS, subject: SUBJECTS[0] },
      { id: randomUUID(), tenant: TENANTS[1], alias: ALIAS, subject: SUBJECTS[1] },
      { id: randomUUID(), tenant: TENANTS[2], alias: ALIAS, subject: SUBJECTS[2] },
    ];
    const passwordHash = await hashPassword(TEST_PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
    for (const account of accounts) {
      const room = account.tenant === 'Steven' ? 'grp.steven' : 'grp.isa';
      const target = account.tenant === 'Steven' ? 'mcp_target_steven' : 'mcp_target_isa';
      await database.pool.query(
        `INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
         VALUES($1,$2,$2,$3,$4,'operator',$5,$6,true)`,
        [account.id, `${account.subject}@example.test`, passwordHash, `MCP ${account.tenant}`, account.tenant, account.alias],
      );
      await database.pool.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
         VALUES($1,$2,$3,'operator',true),($1,$2,$4,'agent',true) ON CONFLICT DO NOTHING`,
        [account.tenant, room, account.alias, target],
      );
      await database.pool.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,container_name,
                            runtime_user,home_directory,state_directory)
         VALUES($1,$2,'claude',true,10,$3,'dev','/home/dev','/home/dev/.cauce/mcp-e2e') ON CONFLICT DO NOTHING`,
        [account.tenant, target, `mcp-e2e-${target}`],
      );
    }
    const subjectBindings = new Map<string, { userId: string; status: 'active' | 'inactive' | 'revoked' }>(
      accounts.map((account) => [account.subject, { userId: account.id, status: 'active' }]),
    );
    return { database, pool: database.pool, repository: new CauceRepository(database.pool), users, issuer,
      accounts, subjectBindings, async close() {
        const failures: unknown[] = [];
        for (const cleanup of [async () => issuer?.close(), async () => database.pool.end(),
          async () => database.container.stop(), async () => { if (directory) await rm(directory, { recursive: true }); }]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'MCP E2E fixture cleanup failed');
      } };
  } catch (error) {
    const failures: unknown[] = [];
    for (const cleanup of [async () => issuer?.close(), async () => database.pool.end(),
      async () => database.container.stop(), async () => { if (directory) await rm(directory, { recursive: true, force: true }); }]) {
      try { await cleanup(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'MCP fixture setup and cleanup failed');
    throw error;
  }
}

export async function startHttpsForwarder(
  key: Buffer, certificate: Buffer, publicHost = 'localhost',
): Promise<HttpsForwarder> {
  let targetPort: number | undefined;
  const server = createHttpsServer({ key, cert: certificate }, (incoming, outgoing) => {
    if (targetPort === undefined || incoming.url === undefined) { outgoing.writeHead(503).end(); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: incoming.url,
      method: incoming.method, headers: incoming.headers, timeout: 10_000 }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.once('timeout', () => upstream.destroy(new Error('MCP HTTPS forwarder timed out')));
    upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  const port = await listen(server);
  return { origin: `https://${publicHost}:${String(port)}`, setTarget(portNumber) { targetPort = portNumber; },
    async close() { await close(server); } };
}

export function fixtureSubjectResolver(
  bindings: ReadonlyMap<string, { userId: string; status: 'active' | 'inactive' | 'revoked' }>,
): ExternalSubjectResolver {
  return Object.freeze({
    async resolve(identity: VerifiedOAuthIdentity, signal: AbortSignal) {
      signal.throwIfAborted();
      const binding = bindings.get(identity.subject);
      return binding === undefined ? undefined : Object.freeze({ ...binding });
    },
  });
}

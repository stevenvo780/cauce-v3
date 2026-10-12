import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, chown, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { configuredHumanMcp } from '../../services/gateway/src/mcp-configuration.js';
import {
  startHumanOperationsFixture, trustFixtureCa,
  type HumanOperationsFixture, type OAuthIssuerFixture,
} from './mcp-human-operations.fixtures.js';

const runFile = promisify(execFile);
const OWNER_LABEL = 'cauce.test.owner';
const SUITE_LABEL = 'cauce.test.suite';
const SUITE_NAME = 'mcp-nginx-mtls';
const NGINX_CONF = '/etc/nginx/conf.d/default.conf';
const RELAY_PIN = 'e'.repeat(64);
const SECRET_NAMES = [
  'console_tls_cert', 'console_tls_key', 'console_tls_ca', 'gateway_tls_ca',
  'console_gateway_client_cert', 'console_gateway_client_key',
] as const;

interface DockerObject {
  readonly Id: string;
  readonly Name?: string;
  readonly Labels?: Record<string, string>;
  readonly Config?: { readonly Labels?: Record<string, string> };
}

interface DockerNetwork extends DockerObject {
  readonly Driver?: string;
  readonly Scope?: string;
  readonly Internal?: boolean;
  readonly IPAM?: { readonly Config?: readonly { readonly Gateway?: string }[] };
}

interface GatewayTlsMaterial {
  readonly ca: Buffer;
  readonly gatewayKey: Buffer;
  readonly gatewayCertificate: Buffer;
  readonly clientKey: Buffer;
  readonly clientCertificate: Buffer;
  readonly wrongCa: Buffer;
  readonly clientFingerprint: string;
}

export interface NginxResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface NginxMcpFixture {
  readonly owner: string;
  readonly networkName: string;
  readonly networkId: string;
  readonly bridgeGateway: string;
  readonly dockerContainerIds: readonly string[];
  readonly postgresContainerId: string;
  readonly nginxImage: string;
  readonly sourceConfigPath: string;
  readonly sourceConfigSha256: string;
  readonly runtimeConfigSha256: Readonly<Record<'primary' | 'wrong-ca', string>>;
  readonly testAdaptations: readonly string[];
  readonly gatewayPort: number;
  readonly tlsPublicHashes: Readonly<Record<string, string>>;
  readonly primaryOrigin: string;
  readonly wrongCaOrigin: string;
  readonly database: HumanOperationsFixture;
  readonly issuer: OAuthIssuerFixture;
  readonly app: FastifyInstance;
  requestNginx(origin: string, path: string, options?: {
    readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string;
  }): Promise<NginxResponse>;
  gatewayMetadataFromNginx(): Promise<string>;
  gatewayWithoutClientCertificate(): Promise<string>;
  nginxLogs(container: 'primary' | 'wrong-ca'): Promise<string>;
  close(): Promise<void>;
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function failureSummary(failures: readonly unknown[]): string {
  return failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join('; ');
}

async function command(file: string, args: readonly string[], timeout = 20_000): Promise<string> {
  try {
    const result = await runFile(file, [...args], { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const record = error as NodeJS.ErrnoException & { stderr?: string };
    const diagnostic = record.stderr?.trim().slice(-1_000) ?? record.code ?? 'unknown error';
    throw new Error(`MCP Nginx fixture command failed: ${file} ${args[0] ?? ''}: ${diagnostic}`);
  }
}

async function docker(args: readonly string[], timeout = 20_000): Promise<string> {
  return command('docker', args, timeout);
}

async function inspectDockerObject<T extends DockerObject>(kind: 'container' | 'network', id: string): Promise<T> {
  const raw = await docker([kind, 'inspect', '--format', '{{json .}}', id]);
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MCP Nginx fixture ${kind} inspection returned invalid data`);
  }
  return value as T;
}

function assertOwned(value: DockerObject, owner: string): void {
  const labels = value.Labels ?? value.Config?.Labels;
  if (labels?.[OWNER_LABEL] !== owner || labels[SUITE_LABEL] !== SUITE_NAME) {
    throw new Error('MCP Nginx fixture refused an object without its exact owner labels');
  }
}

function networkGateway(network: DockerNetwork): string {
  const gateway = network.IPAM?.Config?.[0]?.Gateway;
  if (network.Driver !== 'bridge' || network.Scope !== 'local' || network.Internal !== false
      || typeof gateway !== 'string' || gateway.length === 0) {
    throw new Error('MCP Nginx fixture requires its own local bridge network');
  }
  return gateway;
}

async function createNetwork(owner: string): Promise<{ name: string; id: string; gateway: string }> {
  const name = `cauce-mcp-nginx-${owner}`;
  const id = await docker(['network', 'create', '--driver', 'bridge', '--label', `${OWNER_LABEL}=${owner}`,
    '--label', `${SUITE_LABEL}=${SUITE_NAME}`, name]);
  const network = await inspectDockerObject<DockerNetwork>('network', id);
  assertOwned(network, owner);
  if (network.Id !== id || network.Name !== name) throw new Error('MCP Nginx fixture network identity changed');
  return { name, id, gateway: networkGateway(network) };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('MCP Nginx fixture port reservation failed');
  const { port } = address;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => { if (error) rejectClose(error); else resolveClose(); });
  });
  return port;
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = createTcpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
  });
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => { if (error) rejectClose(error); else resolveClose(); });
  });
}

async function generateGatewayTls(directory: string): Promise<GatewayTlsMaterial> {
  const execute = async (...args: string[]): Promise<void> => {
    try { await runFile('openssl', args, { cwd: directory, timeout: 20_000, maxBuffer: 64 * 1024 }); }
    catch { throw new Error('MCP Nginx fixture ephemeral mTLS certificate generation failed'); }
  };
  await execute('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'gateway-ca.key',
    '-out', 'gateway-ca.pem', '-subj', '/CN=cauce-mcp-nginx-gateway-ca', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  await execute('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'gateway.key', '-out', 'gateway.csr',
    '-subj', '/CN=gateway');
  await writeFile(join(directory, 'gateway.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
      + 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:gateway\n', { mode: 0o600 });
  await execute('x509', '-req', '-in', 'gateway.csr', '-CA', 'gateway-ca.pem', '-CAkey', 'gateway-ca.key',
    '-set_serial', '101', '-days', '1', '-extfile', 'gateway.ext', '-out', 'gateway.pem');
  await execute('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'proxy-client.key', '-out', 'proxy-client.csr',
    '-subj', '/CN=cauce-mcp-nginx-proxy');
  await writeFile(join(directory, 'client.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
      + 'extendedKeyUsage=clientAuth\n', { mode: 0o600 });
  await execute('x509', '-req', '-in', 'proxy-client.csr', '-CA', 'gateway-ca.pem', '-CAkey', 'gateway-ca.key',
    '-set_serial', '102', '-days', '1', '-extfile', 'client.ext', '-out', 'proxy-client.pem');
  await execute('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'wrong-ca.key',
    '-out', 'wrong-ca.pem', '-subj', '/CN=cauce-mcp-nginx-wrong-ca', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const clientCertificate = await readFile(join(directory, 'proxy-client.pem'));
  const fingerprint = new X509Certificate(clientCertificate).fingerprint256.replaceAll(':', '').toLowerCase();
  for (const name of ['gateway-ca.key', 'gateway.key', 'proxy-client.key', 'wrong-ca.key']) {
    await chmod(join(directory, name), 0o600);
  }
  return {
    ca: await readFile(join(directory, 'gateway-ca.pem')),
    gatewayKey: await readFile(join(directory, 'gateway.key')),
    gatewayCertificate: await readFile(join(directory, 'gateway.pem')),
    clientKey: await readFile(join(directory, 'proxy-client.key')),
    clientCertificate,
    wrongCa: await readFile(join(directory, 'wrong-ca.pem')),
    clientFingerprint: fingerprint,
  };
}

async function inspectNginxImage(): Promise<string> {
  const dockerfile = await readFile(new URL('../../deploy/Dockerfile', import.meta.url), 'utf8');
  const pin = /^ARG CAUCE_NGINX_BASE=(\S+)$/mu.exec(dockerfile)?.[1];
  if (pin === undefined || !/@sha256:[a-f0-9]{64}$/u.test(pin)) {
    throw new Error('MCP Nginx fixture could not identify the pinned production Nginx image');
  }
  await docker(['image', 'inspect', pin]);
  return pin;
}

function locationBody(configuration: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^  location = ${escaped} \\{([\\s\\S]*?)^  \\}`, 'mu').exec(configuration);
  if (match?.[1] === undefined) throw new Error(`MCP Nginx config is missing exact location ${path}`);
  return match[1];
}

function validateConfiguration(configuration: string): void {
  const listenerCount = [...configuration.matchAll(/^\s*listen\s+8444 ssl;/gmu)].length;
  if (listenerCount !== 1) throw new Error('MCP Nginx config must keep the existing single TLS listener');
  for (const path of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) {
    const body = locationBody(configuration, path);
    const required = [
      'proxy_pass https://gateway:8443;', 'proxy_set_header Host $http_host;',
      'proxy_set_header Authorization $http_authorization;', 'proxy_set_header Origin $http_origin;',
      'proxy_set_header Connection "";', 'proxy_set_header Cookie "";',
      'proxy_set_header X-Cauce-Operator "";', 'proxy_ssl_name gateway;', 'proxy_ssl_verify on;',
      'proxy_ssl_trusted_certificate /run/secrets/gateway_tls_ca;',
      'proxy_ssl_certificate /run/secrets/console_gateway_client_cert;',
      'proxy_ssl_certificate_key /run/secrets/console_gateway_client_key;',
      'proxy_intercept_errors off;', 'proxy_next_upstream off;', 'proxy_cache off;',
    ];
    for (const directive of required) {
      if (!body.split('\n').some((line) => line.trim() === directive)) {
        throw new Error(`MCP Nginx location ${path} does not preserve ${directive}`);
      }
    }
    if (/\b(?:rewrite|return|try_files|index|alias|root|include|if|proxy_method|proxy_set_body)\b/u.test(body)) {
      throw new Error(`MCP Nginx location ${path} rewrites the canonical ingress request`);
    }
  }
}

function adaptConfiguration(configuration: string, nginxPort: number, gatewayPort: number): string {
  return configuration.replace('${CAUCE_TERMINAL_RELAY_INSTANCE_ID}', RELAY_PIN)
    .replaceAll('/run/secrets/', '/tmp/secrets/')
    .replaceAll('listen 8444 ssl;', `listen 127.0.0.1:${String(nginxPort)} ssl;`)
    .replaceAll('https://gateway:8443', `https://127.0.0.1:${String(gatewayPort)}`);
}

function nginxIdentity(): { uid: number; gid: number } {
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('MCP Nginx fixture requires POSIX UID and GID');
  return uid === 0 ? { uid: 101, gid: 101 } : { uid, gid };
}

async function createSecretDirectory(
  parent: string, issuer: OAuthIssuerFixture, tls: GatewayTlsMaterial, wrongCa = false,
): Promise<string> {
  const directory = join(parent, wrongCa ? 'wrong-secrets' : 'secrets');
  const { uid, gid } = nginxIdentity();
  await mkdir(directory, { mode: 0o700 });
  const content: Record<typeof SECRET_NAMES[number], Buffer> = {
    console_tls_cert: issuer.tlsCertificate,
    console_tls_key: issuer.tlsKey,
    console_tls_ca: issuer.ca,
    gateway_tls_ca: wrongCa ? tls.wrongCa : tls.ca,
    console_gateway_client_cert: tls.clientCertificate,
    console_gateway_client_key: tls.clientKey,
  };
  for (const name of SECRET_NAMES) {
    const secretPath = join(directory, name);
    await writeFile(secretPath, content[name], { mode: 0o600 });
    await chmod(secretPath, 0o600);
    if (process.getuid?.() === 0) await chown(secretPath, uid, gid);
  }
  if (process.getuid?.() === 0) await chown(directory, uid, gid);
  return directory;
}

async function startNginx(
  image: string, port: number, configPath: string, secretsPath: string, owner: string,
  createdContainerIds: string[],
): Promise<{ id: string; origin: string }> {
  await assertLoopbackPortAvailable(port);
  const name = `cauce-mcp-nginx-${owner}-${secretsPath.endsWith('wrong-secrets') ? 'wrong' : 'primary'}`;
  const { uid, gid } = nginxIdentity();
  const id = await docker(['run', '--detach', '--name', name, '--label', `${OWNER_LABEL}=${owner}`,
    '--label', `${SUITE_LABEL}=${SUITE_NAME}`, '--network', 'host', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--user', `${String(uid)}:${String(gid)}`,
    '--mount', `type=bind,src=${configPath},dst=${NGINX_CONF},readonly`,
    '--mount', `type=bind,src=${secretsPath},dst=/tmp/secrets,readonly`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=16m,uid=${String(uid)},gid=${String(gid)},mode=0700`,
    '--tmpfs', `/var/cache/nginx:rw,noexec,nosuid,size=8m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--tmpfs', `/var/run:rw,noexec,nosuid,size=8m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--tmpfs', `/var/log/nginx:rw,noexec,nosuid,size=8m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--entrypoint', 'sleep', image, '600']);
  createdContainerIds.push(id);
  const object = await inspectDockerObject<DockerObject>('container', id);
  assertOwned(object, owner);
  if (object.Id !== id || object.Name !== `/${name}`) throw new Error('MCP Nginx fixture container identity changed');
  const status = await docker(['exec', id, 'cat', '/proc/self/status']);
  if (!new RegExp(`^Uid:\\s+${String(uid)}\\s+${String(uid)}\\s+${String(uid)}\\s+${String(uid)}$`, 'mu').test(status)
      || !new RegExp(`^Gid:\\s+${String(gid)}\\s+${String(gid)}\\s+${String(gid)}\\s+${String(gid)}$`, 'mu').test(status)
      || !/^CapEff:\s+0+$/mu.test(status) || !/^NoNewPrivs:\s+1$/mu.test(status)) {
    throw new Error('MCP Nginx fixture runtime identity or capabilities differ from its security contract');
  }
  console.info('MCP_NGINX_RUNTIME_IDENTITY', JSON.stringify({ hostUid: process.getuid?.(), uid, gid, capabilities: 'none' }));
  await docker(['exec', id, 'nginx', '-t']);
  await docker(['exec', '--detach', id, 'nginx', '-g', 'daemon off;']);
  return { id, origin: `https://localhost:${String(port)}` };
}

function request(origin: string, path: string, options: {
  readonly ca: Buffer;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}): Promise<NginxResponse> {
  const url = new URL(path, origin);
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRequest(error);
    };
    const outgoing = httpsRequest(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      ca: options.ca,
      servername: 'localhost',
      rejectUnauthorized: true,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.once('error', finishError);
      incoming.once('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRequest({ status: incoming.statusCode ?? 0, headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const timer = setTimeout(() => outgoing.destroy(new Error('MCP Nginx HTTPS request timed out')),
      options.timeoutMs ?? 5_000);
    outgoing.once('error', finishError);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function waitForNginxFrontend(origin: string, ca: Buffer, id: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    try {
      await request(origin, '/', { ca, timeoutMs: 500 });
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  const state = await docker(['container', 'inspect', '--format', '{{.State.Status}}/{{.State.ExitCode}}', id]);
  const logs = (await docker(['container', 'logs', id], 5_000)).slice(-2_000);
  throw new Error(`MCP Nginx TLS frontend did not become ready (${state}; ${lastFailure}): ${logs}`);
}

async function removeOwnedContainer(id: string, owner: string): Promise<void> {
  const object = await inspectDockerObject<DockerObject>('container', id);
  assertOwned(object, owner);
  await docker(['container', 'rm', '--force', id]);
}

async function removeOwnedNetwork(id: string, owner: string): Promise<void> {
  const object = await inspectDockerObject<DockerNetwork>('network', id);
  assertOwned(object, owner);
  await docker(['network', 'rm', id]);
}

export async function startNginxMcpFixture(): Promise<NginxMcpFixture> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined || process.env.CAUCE_TEST_DOCKER_NETWORK !== undefined
      || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER !== undefined) {
    throw new Error('MCP Nginx fixture refuses inherited database or Docker network overrides');
  }
  const owner = randomUUID();
  const root = await mkdtemp(join(tmpdir(), `cauce-mcp-nginx-${owner}-`));
  await chmod(root, 0o755);
  const tlsDirectory = join(root, 'tls');
  await mkdir(tlsDirectory, { mode: 0o700 });
  let network: { name: string; id: string; gateway: string } | undefined;
  let database: HumanOperationsFixture | undefined;
  let issuer: OAuthIssuerFixture | undefined;
  let restoreTrust: (() => void) | undefined;
  let app: FastifyInstance | undefined;
  const containers: string[] = [];
  let networkEnvironment: { require?: string } | undefined;
  let primary: { id: string; origin: string } | undefined;
  let wrong: { id: string; origin: string } | undefined;
  try {
    const configPath = process.env.CAUCE_E2E_NGINX_CONFIG ?? fileURLToPath(new URL('../../deploy/console/nginx-console-tls.conf', import.meta.url));
    const source = await readFile(configPath);
    const configuration = source.toString('utf8');
    validateConfiguration(configuration);
    const sourceConfigSha256 = digest(source);
    const nginxImage = await inspectNginxImage();
    const ownedNetwork = await createNetwork(owner);
    network = ownedNetwork;
    networkEnvironment = process.env.CAUCE_REQUIRE_TESTCONTAINERS === undefined
      ? {} : { require: process.env.CAUCE_REQUIRE_TESTCONTAINERS };
    process.env.CAUCE_TEST_DOCKER_NETWORK = ownedNetwork.name;
    process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER = owner;
    process.env.CAUCE_REQUIRE_TESTCONTAINERS = '1';
    database = await startHumanOperationsFixture();
    delete process.env.CAUCE_TEST_DOCKER_NETWORK;
    delete process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER;
    if (networkEnvironment.require === undefined) delete process.env.CAUCE_REQUIRE_TESTCONTAINERS;
    else process.env.CAUCE_REQUIRE_TESTCONTAINERS = networkEnvironment.require;
    if (networkEnvironment.require === undefined) delete process.env.CAUCE_REQUIRE_TESTCONTAINERS;
    issuer = database.issuer;
    restoreTrust = await trustFixtureCa(issuer.ca);
    const tls = await generateGatewayTls(tlsDirectory);
    const primaryPort = await reserveLoopbackPort();
    const wrongCaPort = await reserveLoopbackPort();
    const publicOrigin = `https://localhost:${String(primaryPort)}`;
    const humanMcp = configuredHumanMcp({
      CAUCE_MCP_PUBLIC_ORIGIN: publicOrigin,
      CAUCE_MCP_OAUTH_ISSUER: issuer.issuer,
      CAUCE_MCP_OAUTH_JWKS_URI: issuer.jwksUri,
    });
    if (humanMcp === undefined) throw new Error('MCP Nginx fixture did not configure the real OAuth ingress');
    const identitiesPath = join(root, 'mtls-identities.json');
    await writeFile(identitiesPath, JSON.stringify({ version: 1, identities: [{
      certificate_sha256: tls.clientFingerprint,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      principal: { tenant_id: 'Steven', alias: 'mcp_ingress_proxy', session_id: randomUUID(),
        channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] },
    }] }), { mode: 0o600 });
    const authProvider = new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identitiesPath));
    const gatewayApp = await buildGateway({
      pool: database.pool,
      authProvider,
      https: { key: tls.gatewayKey, cert: tls.gatewayCertificate, ca: tls.ca,
        requestCert: true, rejectUnauthorized: true },
      humanMcp,
      logger: false,
    });
    app = gatewayApp;
    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    const gatewayAddress = gatewayApp.server.address();
    if (gatewayAddress === null || typeof gatewayAddress === 'string') {
      throw new Error('MCP Nginx fixture gateway listener did not expose a TCP address');
    }
    const gatewayPort = gatewayAddress.port;
    const primaryRuntimeConfig = adaptConfiguration(configuration, primaryPort, gatewayPort);
    const wrongCaRuntimeConfig = adaptConfiguration(configuration, wrongCaPort, gatewayPort);
    const primaryConfigPath = join(root, 'primary.conf');
    const wrongCaConfigPath = join(root, 'wrong-ca.conf');
    await writeFile(primaryConfigPath, primaryRuntimeConfig, { mode: 0o444 });
    await writeFile(wrongCaConfigPath, wrongCaRuntimeConfig, { mode: 0o444 });
    const secretsPath = await createSecretDirectory(root, issuer, tls);
    const wrongSecretsPath = await createSecretDirectory(root, issuer, tls, true);
    for (const [configPath, secretPath, name, port] of [
      [primaryConfigPath, secretsPath, 'primary', primaryPort],
      [wrongCaConfigPath, wrongSecretsPath, 'wrong', wrongCaPort],
    ] as const) {
      const started = await startNginx(nginxImage, port, configPath, secretPath, owner, containers);
      if (name === 'primary') primary = started;
      else wrong = started;
    }
    const publicNginx = primary;
    const wrongCaNginx = wrong;
    if (publicNginx === undefined || wrongCaNginx === undefined) throw new Error('MCP Nginx fixture failed to start both proxies');
    await waitForNginxFrontend(publicNginx.origin, issuer.ca, publicNginx.id);
    await waitForNginxFrontend(wrongCaNginx.origin, issuer.ca, wrongCaNginx.id);
    const runtimeConfigSha256 = {
      primary: digest(primaryRuntimeConfig),
      'wrong-ca': digest(wrongCaRuntimeConfig),
    };
    const tlsPublicHashes = {
      issuerCa: digest(issuer.ca),
      frontendCertificate: digest(issuer.tlsCertificate),
      gatewayCa: digest(tls.ca),
      gatewayCertificate: digest(tls.gatewayCertificate),
      proxyClientCertificate: digest(tls.clientCertificate),
      negativeCa: digest(tls.wrongCa),
    };
    return {
      owner,
      networkName: network.name,
      networkId: network.id,
      bridgeGateway: ownedNetwork.gateway,
      gatewayPort,
      dockerContainerIds: [...containers],
      postgresContainerId: database.database.container.getId(),
      nginxImage,
      sourceConfigPath: configPath,
      sourceConfigSha256,
      runtimeConfigSha256,
      testAdaptations: [
        'Nginx HTTPS listener is bound to exact 127.0.0.1 with an ephemeral test port.',
        'Gateway HTTPS listener is bound to exact 127.0.0.1 with an ephemeral test port.',
        'Nginx QA certificate paths use the fixture-owned /tmp/secrets directory.',
        'The relay build-time pin is test-owned; proxy_ssl_name, CA verification and original Host/Origin headers are unchanged.',
      ],
      tlsPublicHashes,
      primaryOrigin: publicNginx.origin,
      wrongCaOrigin: wrongCaNginx.origin,
      database,
      issuer,
      app: gatewayApp,
      requestNginx(origin, path, options = {}) {
        return request(origin, path, { ca: issuer?.ca ?? Buffer.alloc(0), ...options });
      },
      async gatewayMetadataFromNginx() {
        return docker(['exec', publicNginx.id, 'curl', '--silent', '--show-error', '--connect-timeout', '2',
          '--max-time', '5', '--resolve', `gateway:${String(gatewayPort)}:127.0.0.1`,
          '--header', `Host: localhost:${String(primaryPort)}`,
          '--cacert', '/tmp/secrets/gateway_tls_ca', '--cert',
          '/tmp/secrets/console_gateway_client_cert', '--key', '/tmp/secrets/console_gateway_client_key',
          '--write-out', '\nstatus=%{http_code}',
          `https://gateway:${String(gatewayPort)}/.well-known/oauth-protected-resource/mcp`], 7_000);
      },
      async gatewayWithoutClientCertificate() {
        return new Promise((resolveError, rejectError) => {
          let settled = false;
          const finish = (error?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined) rejectError(new Error('gateway accepted absent mTLS client certificate'));
            else resolveError(error);
          };
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectError(error);
          };
          const outgoing = httpsRequest({ hostname: '127.0.0.1', port: gatewayPort, path: '/mcp', method: 'GET',
            servername: 'gateway', ca: tls.ca, rejectUnauthorized: true }, (response) => {
            response.resume();
            response.once('end', () => { finish(); });
          });
          const timer = setTimeout(() => outgoing.destroy(new Error('mTLS negative timed out')), 3_000);
          outgoing.once('error', (error: NodeJS.ErrnoException) => {
            if (['ECONNRESET', 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
              'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'].includes(error.code ?? '')) {
              finish(error.code ?? 'TLS handshake rejected');
              return;
            }
            fail(new Error(`gateway mTLS negative failed unexpectedly: ${error.code ?? error.message}`));
          });
          outgoing.end();
        });
      },
      async nginxLogs(kind) {
        const selected = kind === 'primary' ? publicNginx : wrongCaNginx;
        const [stdout, errorLog] = await Promise.all([
          docker(['container', 'logs', selected.id], 5_000),
          docker(['exec', selected.id, 'cat', '/var/log/nginx/error.log'], 5_000).catch(() => ''),
        ]);
        return `${stdout}\n${errorLog}`;
      },
      async close() {
        const failures: unknown[] = [];
        for (const cleanup of [
          async () => { if (app) { await app.close(); } },
          async () => { if (restoreTrust) restoreTrust(); },
          async () => { if (database) await database.close(); },
          async () => { for (const id of [...containers].reverse()) await removeOwnedContainer(id, owner); },
          async () => { if (network) await removeOwnedNetwork(network.id, owner); },
          async () => { await rm(root, { recursive: true }); },
        ]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures,
          `MCP Nginx fixture cleanup failed: ${failureSummary(failures)}`);
      },
    };
  } catch (error) {
    if (networkEnvironment !== undefined) {
      delete process.env.CAUCE_TEST_DOCKER_NETWORK;
      delete process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER;
      if (networkEnvironment.require === undefined) delete process.env.CAUCE_REQUIRE_TESTCONTAINERS;
      else process.env.CAUCE_REQUIRE_TESTCONTAINERS = networkEnvironment.require;
    }
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => { if (app) { await app.close(); } },
      async () => { if (restoreTrust) restoreTrust(); },
      async () => { if (database) await database.close(); },
      async () => { for (const id of [...containers].reverse()) await removeOwnedContainer(id, owner); },
      async () => { if (network) await removeOwnedNetwork(network.id, owner); },
      async () => { await rm(root, { recursive: true, force: true }); },
    ]) {
      try { await cleanup(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) {
      const causes = [error, ...failures];
      throw new AggregateError(causes,
        `MCP Nginx fixture setup and cleanup failed: ${failureSummary(causes)}`);
    }
    throw error;
  }
}

export async function nginxRequest(fixture: NginxMcpFixture, origin: string, path: string, options?: {
  readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string;
}): Promise<NginxResponse> {
  return fixture.requestNginx(origin, path, options);
}

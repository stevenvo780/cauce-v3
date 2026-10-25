import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Agent } from 'node:https';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CauceRepository, FleetOperationsRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { docker, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { createPtyFleetPki, startPtyFleetRelay } from './v4-pty-flota-dinamica.infra.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
interface ConsoleServer { close(): Promise<void>; listen(): Promise<void> }
interface QaViteServer extends ConsoleServer {
  middlewares: { use(path: string, handler: (request: IncomingMessage, response: ServerResponse) => void): void };
}
export interface QaLabApplication {
  relay: { available: boolean; instanceId: string };
  close(): Promise<void>;
}

async function frontendCertificate(directory: string, authority: string, externalUrl: string) {
  const host = new URL(externalUrl).hostname.replace(/^\[|\]$/gu, '');
  const san = ['DNS:localhost', 'IP:127.0.0.1', `${isIP(host) ? 'IP' : 'DNS'}:${host}`];
  const key = join(directory, 'frontend.key'), cert = join(directory, 'frontend.crt');
  const config = join(directory, 'frontend.cnf'), csr = join(directory, 'frontend.csr');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=qa-lab\n'
    + '[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
    + `extendedKeyUsage=serverAuth\nsubjectAltName=${[...new Set(san)].join(',')}\n`, { mode: 0o600 });
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', config]);
  await chmod(key, 0o600);
  await execute('openssl', ['x509', '-req', '-in', csr, '-CA', join(authority, 'ca.crt'), '-CAkey', join(authority, 'ca.key'),
    '-CAcreateserial', '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  return { key, cert };
}

export async function startQaLabApplication(options: {
  computer: ComputerHarness; directory: string; prefix: string; email: string; origins: string[];
  url: string; ticketKey: Buffer; ports: { gateway: number; browser: number; agent: number; health: number };
  releasePorts(): Promise<void>;
}): Promise<QaLabApplication> {
  const { computer, directory, prefix, email, origins, url, ticketKey, ports } = options;
  const authority = join(dirname(computer.installRoot), 'authority');
  const registryFile = join(authority, 'pty/pty_agent_identities.json');
  const registry = new AgentRegistry();
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let transport: Agent | undefined, vite: ConsoleServer | undefined;
  let relay: Awaited<ReturnType<typeof startPtyFleetRelay>> | undefined;
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const action of [async () => vite?.close(), async () => relay?.close(), async () => gateway?.close(),
      async () => transport?.destroy()]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'QA application cleanup failed');
  };
  try {
    const pki = await createPtyFleetPki(directory, authority);
    const publicCa = join(dirname(directory), 'ca.crt');
    await copyFile(pki.ca, publicCa);
    await chmod(publicCa, 0o600);
    const frontend = await frontendCertificate(directory, authority, url);
    const relayToken = randomBytes(32).toString('base64url'), tokenFile = join(directory, 'relay-token');
    const identities = join(directory, 'relay-identities.json'), grantsFile = join(directory, 'grants.json');
    await writeFile(tokenFile, relayToken, { mode: 0o600 });
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
    await writeFile(join(directory, 'close-spool.json'), '', { mode: 0o600 });
    await mkdir(join(directory, 'recordings'), { mode: 0o700 });
    await writeFile(identities, JSON.stringify({ version: 1, identities: [{ certificate_sha256: pki.relayId,
      expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), principal: { tenant_id: prefix,
        alias: `${prefix}-relay`, session_id: randomUUID(), channel: 'agent', roles: ['adapter'], permissions: ['read'] } }] }), { mode: 0o600 });
    const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(computer.pool), signingKey: Buffer.alloc(32, 61),
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)) });
    const config: TerminalConfig = { wsPath: '/v3/console/terminal/ws', ticketKey, relayToken,
      relayInstanceIds: new Set([pki.relayId]), grantsFile, ticketTtlSeconds: 60, sessionTtlSeconds: 900,
      claimLeaseSeconds: 150, maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set([email]),
      writableTuiEnabled: true, controlHoldSeconds: 300 };
    const uid = process.geteuid?.() ?? 0;
    gateway = await buildGateway({ pool: computer.pool, repository: new CauceRepository(computer.pool), logger: false,
      consoleOrigins: origins, authProvider: auth, hostSetup: computer.packager,
      fleetOperationsRepository: new FleetOperationsRepository(computer.pool),
      signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(authority, 'signed.sock'), { ownerUid: uid, peerUid: uid }),
      https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert), ca: await readFile(pki.ca),
        requestCert: true, rejectUnauthorized: true }, terminalCapability: terminalCapabilityAnnouncement(config) });
    await gateway.register(registerTerminalControlPlane, { pool: computer.pool, authProvider: auth, config, registry });
    await options.releasePorts();
    const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: ports.gateway });
    transport = new Agent({ cert: await readFile(pki.console.cert), key: await readFile(pki.console.key),
      ca: await readFile(pki.ca), rejectUnauthorized: true });
    const healthPlugin = { name: 'qa-lab-health', configureServer(server: QaViteServer) {
      server.middlewares.use('/__qa/status', (request, response) => {
        void (async () => {
          let ready = false;
          if (request.method === 'GET') {
            try {
              const [, running] = await Promise.all([
                computer.pool.query('SELECT 1'), docker(['inspect', '--format', '{{.State.Running}}', computer.container]),
              ]);
              ready = running === 'true' && registry.available();
            } catch { ready = false; }
          }
          response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ ready }));
        })();
      });
    } };
    const projectRoot = process.cwd();
    process.chdir(directory);
    try {
      vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<ConsoleServer> }).createServer({
      configFile: join(projectRoot, 'console/vite.config.ts'), root: join(projectRoot, 'console'), envDir: directory,
      plugins: [healthPlugin],
      cacheDir: join(directory, 'vite-cache'), server: { host: '0.0.0.0', port: 4443, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(frontend.key), cert: await readFile(frontend.cert) },
        proxy: { [`/v3/console/terminal/relays/${pki.relayId}/ws`]: {
          target: `https://127.0.0.1:${String(ports.browser)}`, agent: transport, secure: true, changeOrigin: false, ws: true },
        '/v3': { target: gatewayUrl, agent: transport, secure: true, changeOrigin: false, ws: true } } } });
    } finally { process.chdir(projectRoot); }
    await vite.listen();
    relay = await startPtyFleetRelay({ directory, gatewayUrl, registry: registryFile, pki, ports, tokenFile });
    const deadline = Date.now() + 30_000;
    while (!registry.available() && Date.now() < deadline) await new Promise<void>(resolve => { setTimeout(resolve, 100); });
    if (!registry.available()) throw new Error('QA terminal relay presence was not confirmed');
    return { relay: { available: true, instanceId: pki.relayId }, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'QA application startup and cleanup failed'); }
    throw error;
  }
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

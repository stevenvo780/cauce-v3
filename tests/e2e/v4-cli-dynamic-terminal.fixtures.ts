import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chown, chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { deriveAliasKey } from '../../services/gateway/src/terminal/tickets.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { closeTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { reserveNamedLoopbackPorts } from './port-reservation.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
export interface DynamicCliResult { code: number | null; stdout: string; stderr: string }
export interface RemoteCliRelocation {
  relayHost: string;
  sourceHost: string;
  sourceRelayPort: number;
  destination: { container: string; host: string; home: string };
  start(bundle: Record<string, unknown>, marker: string): Promise<void>;
}

export async function runDynamicCli(args: string[], sessionFile: string | undefined, input = '', detachWhen?: string): Promise<DynamicCliResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('bash', [join(root, 'ops/cli/cauce'), ...args], {
      cwd: root, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1',
        ...(sessionFile === undefined ? { XDG_STATE_HOME: '/nonexistent-cauce-session' } : { CAUCE_CONSOLE_SESSION_FILE: sessionFile }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let expired = false; let detached = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-64 * 1024);
      if (detachWhen !== undefined && stdout.includes(detachWhen) && !detached) {
        detached = true;
        child.stdin.end('\x1d');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('dynamic terminal CLI exceeded its deadline'));
      else resolveResult({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    if (detachWhen === undefined) child.stdin.end(input);
    else child.stdin.write(input);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
    const deadline = setTimeout(() => { reject(new Error('dynamic terminal fixture process did not exit')); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolveExit(); });
  });
  child.kill('SIGTERM');
  await exited;
}

function startProxy(gateway: string, relay: string, agent: Agent, paths: string[]): { server: Server; sockets: Set<Duplex> } {
  const sockets = new Set<Duplex>();
  const server = createServer((incoming, outgoing) => {
    paths.push(`${incoming.method ?? 'GET'} ${incoming.url ?? '/'}`);
    const upstream = httpsRequest(gateway + (incoming.url ?? '/'), {
      method: incoming.method, agent,
      headers: { ...incoming.headers, host: new URL(gateway).host, origin: gateway },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (incoming, socket, head) => {
    paths.push(`WS ${incoming.url ?? '/'}`);
    const upstream = httpsRequest(relay + (incoming.url ?? '/'), {
      agent, headers: { ...incoming.headers, host: new URL(relay).host, origin: relay },
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote);
      remote.once('close', () => sockets.delete(remote));
      let headers = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers += `${response.rawHeaders[index] ?? ''}: ${response.rawHeaders[index + 1] ?? ''}\r\n`;
      }
      socket.write(headers + '\r\n');
      if (remoteHead.length > 0) socket.write(remoteHead);
      if (head.length > 0) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on('error', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.once('close', () => remote.destroy());
      remote.once('close', () => socket.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  return { server, sockets };
}

export async function startDynamicTerminalFixture(options: { tui?: boolean; remoteRelocation?: RemoteCliRelocation } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zz-canary-cli-terminal-'));
  const runtimeUid = process.getuid?.() === 0 ? 1000 : userInfo().uid;
  const runtimeGid = process.getuid?.() === 0 ? 1000 : userInfo().gid;
  if (process.getuid?.() === 0) await chown(directory, runtimeUid, runtimeGid);
  const identity = { uid: runtimeUid, gid: runtimeGid };
  const account = await execute('getent', ['passwd', String(runtimeUid)]);
  const runtimeUser = account.stdout.split(':')[0];
  if (!runtimeUser) throw new Error('the real PTY fixture requires a normal runtime account');
  const ports = await reserveNamedLoopbackPorts(['browser', 'agent', 'health', 'frontend']);
  const agentPort = options.remoteRelocation?.sourceRelayPort ?? ports.ports.agent;
  let database: TestDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let proxy: ReturnType<typeof startProxy> | undefined;
  let transport: Agent | undefined;
  const children: ChildProcess[] = [];
  const paths: string[] = [];
  let logs = '';
  let tmuxSocket: string | undefined;
  let tmuxOwned = false;
  let tmuxSocketPath: string | undefined;
  let tmuxSocketIdentity: string | undefined;
  const movedContainers: string[] = [];
  const socketStatus = async (path: string) => await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  const tmux = async (args: string[]) => {
    if (tmuxSocket === undefined) throw new Error('this fixture has no owned tmux socket');
    return await execute('/usr/bin/tmux', ['-L', tmuxSocket, '-f', '/dev/null', ...args], {
      ...identity, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeout: 5_000, maxBuffer: 64 * 1024,
    });
  };
  const close = async () => {
    const errors: unknown[] = [];
    for (const name of movedContainers) {
      try {
        const owned = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "cauce.e2e.owner"}}', name]);
        if (owned.stdout.trim() !== 'e2e-a9-cli-1025b') throw new Error('relocated PTY container ownership changed');
        await execute('docker', ['rm', '--force', name]);
      } catch (error) {
        if (!(error instanceof Error && /No such (?:object|container)/u.test(error.message))) errors.push(error);
      }
    }
    for (const child of children.reverse()) { try { await stopChild(child); } catch (error) { errors.push(error); } }
    if (tmuxOwned) {
      try {
        await tmux(['kill-server']);
        if (tmuxSocketPath !== undefined) {
          const status = await socketStatus(tmuxSocketPath);
          if (status !== undefined) {
            if (!status.isSocket() || status.uid !== runtimeUid || `${String(status.dev)}:${String(status.ino)}` !== tmuxSocketIdentity) {
              throw new Error('refusing to remove a changed tmux socket');
            }
            await unlink(tmuxSocketPath);
          }
        }
      } catch (error) { errors.push(error); }
    }
    if (proxy?.server.listening) {
      for (const socket of proxy.sockets) socket.destroy();
      const server = proxy.server;
      try { await new Promise<void>((resolveClose, reject) => server.close(error => { if (error) reject(error); else resolveClose(); })); }
      catch (error) { errors.push(error); }
    }
    transport?.destroy();
    try { await app?.close(); } catch (error) { errors.push(error); }
    try { await closeTestDatabase(database); } catch (error) { errors.push(error); }
    try { await ports.releaseAll(); } catch (error) { errors.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, 'dynamic terminal fixture cleanup failed');
  };
  const privateFile = async (name: string, contents: string): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, contents, { mode: 0o600 });
    if (process.getuid?.() === 0) await chown(path, runtimeUid, runtimeGid);
    return path;
  };
  try {
    database = await startTestDatabase({ requireOwnedContainer: true });
    const tls = createSelfSignedCert({ directory });
    if (process.getuid?.() === 0) {
      for (const path of [tls.directory, tls.cert_path, tls.key_path]) await chown(path, runtimeUid, runtimeGid);
    }
    await chmod(tls.key_path, 0o600);
    const relayId = relayInstanceIdFromCertificate(tls.cert);
    const suffix = randomBytes(5).toString('hex');
    const alias = `zz-canary-${suffix}`;
    const operator = `zz-canary-op-${suffix}`;
    const tenant = 'Steven';
    const email = `zz-canary-${suffix}@cauce.test`;
    const password = randomBytes(24).toString('base64url');
    const container = `zz-canary-host-${suffix}`;
    const home = join(directory, 'home');
    await mkdir(home, { mode: 0o700 });
    if (process.getuid?.() === 0) await chown(home, runtimeUid, runtimeGid);
    const recordingDirectory = join(directory, 'recordings');
    if (options.tui) {
      await mkdir(recordingDirectory, { mode: 0o700 });
      if (process.getuid?.() === 0) await chown(recordingDirectory, runtimeUid, runtimeGid);
      tmuxSocket = alias;
      tmuxSocketPath = `/tmp/tmux-${String(runtimeUid)}/${tmuxSocket}`;
      if (await socketStatus(tmuxSocketPath) !== undefined) throw new Error('refusing to reuse an existing tmux socket');
      await tmux(['new-session', '-d', '-s', `cauce-${alias}`, '-n', 'agente', '-c', home, '-x', '100', '-y', '30',
        '-e', `HOME=${home}`, '-e', 'HISTFILE=/dev/null', '/bin/sh']);
      tmuxOwned = true;
      const createdSocket = await lstat(tmuxSocketPath);
      tmuxSocketIdentity = `${String(createdSocket.dev)}:${String(createdSocket.ino)}`;
      await tmux(['set-option', '-t', `cauce-${alias}`, '@cauce_alias', alias]);
      await tmux(['set-option', '-t', `cauce-${alias}`, '@cauce_harness', 'codex']);
      await tmux(['set-window-option', '-t', `cauce-${alias}:agente`, 'automatic-rename', 'off']);
    }
    await database.pool.query('INSERT INTO tenants(id) VALUES($1) ON CONFLICT DO NOTHING', [tenant]);
    await database.pool.query("INSERT INTO harness_definitions(id,display_name,capabilities) VALUES('cli-pty-e2e','CLI PTY E2E','[]'::jsonb) ON CONFLICT DO NOTHING");
    await database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [alias, tenant]);
    for (const [target, role] of [[alias, 'agent'], [operator, 'operator']] as const) {
      await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
        VALUES($1,$2,'cli-pty-e2e',true,$3,$4,$5,$6)`, [tenant, target, target === alias ? container : `${container}-op`, runtimeUser, home, join(home, '.cauce')]);
      await database.pool.query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,$4)', [tenant, alias, target, role]);
    }
    if (options.remoteRelocation) {
      await database.pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
        SELECT $1,$1,company_id FROM agents WHERE tenant_id=$2 AND alias=$3`, [options.remoteRelocation.sourceHost, tenant, alias]);
      await database.pool.query('UPDATE agents SET host_id=$1 WHERE tenant_id=$2 AND alias=$3', [options.remoteRelocation.sourceHost, tenant, alias]);
    }
    await maintainConsoleUser(database.pool, { email, name: 'CLI PTY E2E operator', role: 'operator', tenant,
      alias: operator, updateOnly: false, activate: false }, await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 }));
    const relayToken = randomBytes(32).toString('base64url');
    const ticketKey = randomBytes(32);
    const grants = await privateFile('grants.json', JSON.stringify({ version: 1, grants: [{ operator: email, tenant_id: tenant, alias,
      modes: options.tui ? ['shell', 'harness', 'harness_rw'] : ['shell'] }] }));
    const relayTokenFile = await privateFile('relay-token', relayToken);
    const spool = await privateFile('close-spool.json', '');
    const agentRegistry = await privateFile('agent-registry.json', JSON.stringify({ version: 1, agents: [{
      fingerprint_sha256: relayId, tenant_id: tenant, alias, expires_at: new Date(Date.now() + 600_000).toISOString(),
    }] }));
    const relayIdentities = await privateFile('relay-identities.json', JSON.stringify({ version: 1, identities: [{
      certificate_sha256: relayId, expires_at: new Date(Date.now() + 600_000).toISOString(), principal: {
        tenant_id: tenant, alias: operator, session_id: randomUUID(), channel: 'agent', roles: ['adapter'], permissions: ['read'],
      },
    }] }));
    const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(database.pool), signingKey: randomBytes(32),
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(relayIdentities)) });
    const config: TerminalConfig = { wsPath: '/v3/console/terminal/ws', ticketKey, relayToken, relayInstanceIds: new Set([relayId]),
      grantsFile: grants, ticketTtlSeconds: 60, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set([email]),
      ...(options.tui ? { writableTuiEnabled: true, controlHoldSeconds: 300 } : {}) };
    app = await buildGateway({ pool: database.pool, authProvider: auth,
      https: { key: tls.key, cert: tls.cert, ca: tls.cert, requestCert: true, rejectUnauthorized: true },
      terminalCapability: terminalCapabilityAnnouncement(config) });
    const registry = new AgentRegistry();
    await app.register(registerTerminalControlPlane, { pool: database.pool, authProvider: auth, config, registry });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    transport = new Agent({ cert: tls.cert, key: tls.key, ca: tls.cert, rejectUnauthorized: true });
    const relayUrl = `https://127.0.0.1:${String(ports.ports.browser)}`;
    proxy = startProxy(gateway, relayUrl, transport, paths);
    await ports.release('frontend');
    await new Promise<void>(resolveListen => proxy?.server.listen(ports.ports.frontend, '127.0.0.1', resolveListen));
    const frontend = `http://127.0.0.1:${String(ports.ports.frontend)}`;
    const relayEnv = {
      PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: tls.cert_path, NODE_ENV: 'test',
      CAUCE_TERMINAL_RELAY_BIND_HOST: options.remoteRelocation ? '0.0.0.0' : '127.0.0.1', CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(ports.ports.browser),
      CAUCE_TERMINAL_RELAY_AGENT_PORT: String(agentPort), CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(ports.ports.health),
      CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: tls.cert_path, CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: tls.key_path,
      CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: tls.cert_path, CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'localhost',
      CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: tls.cert_path, CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: agentRegistry,
      CAUCE_TERMINAL_GATEWAY_URL: gateway, CAUCE_TERMINAL_RELAY_TOKEN_FILE: relayTokenFile,
      CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: tls.cert_path, CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: tls.key_path,
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: relayId, CAUCE_TERMINAL_CLOSE_SPOOL_FILE: spool,
      CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1', CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
      ...(options.tui ? { CAUCE_TERMINAL_RECORDING_DIR: recordingDirectory } : {}),
    };
    await ports.release('browser'); await ports.release('agent'); await ports.release('health');
    const relay = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], {
      cwd: root, env: relayEnv, stdio: ['ignore', 'pipe', 'pipe'], ...identity,
    });
    children.push(relay);
    const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-12 * 1024); };
    relay.stdout.on('data', capture); relay.stderr.on('data', capture);
    const bundleConfiguration = { tenant_id: tenant, alias, container_id: container,
      generation: `g${suffix}`, image_id: `sha256:${'a'.repeat(64)}`, runtime_user: runtimeUser, runtime_uid: runtimeUid,
      runtime_gid: runtimeGid, home, shell_candidates: ['/bin/sh'], harness: options.tui ? 'codex' : 'shell', relay_host: '127.0.0.1',
      relay_port: agentPort, relay_server_name: 'localhost', alias_key_hex: deriveAliasKey(ticketKey, tenant, alias).toString('hex'),
      client_cert_pem: tls.cert.toString(), client_key_pem: tls.key.toString(), ca_pem: tls.cert.toString(), agent_version: 'cli-pty-e2e',
      ...(options.tui ? { tmux_tui: { path: '/usr/bin/tmux', socket: tmuxSocket } } : {}),
    };
    const bundle = await privateFile('agent-bundle.json', JSON.stringify(bundleConfiguration));
    const python = spawn('python3', ['-m', 'cauce_pty_agent', '--bundle', bundle], {
      cwd: home, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'ops/pty-agent') },
      stdio: ['ignore', 'pipe', 'pipe'], ...identity,
    });
    children.push(python); python.stdout.on('data', capture); python.stderr.on('data', capture);
    const deadline = Date.now() + 30_000;
    while (registry.state(tenant, alias, Date.now()) !== 'online') {
      if (Date.now() >= deadline || children.some(child => child.exitCode !== null)) throw new Error(`real dynamic PTY did not become online: ${logs}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    const sessionFile = join(directory, 'console-session.json');
    const login = await runDynamicCli(['login', '--gateway', frontend, '--email', email, '--password-stdin', '--session-file', sessionFile], sessionFile, `${password}\n`);
    if (login.code !== 0) throw new Error(`dynamic CLI login failed: ${login.stderr}`);
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as { cookie: string; csrf_token: string };
    return { database, directory, alias, tenant, email, runtimeUid, home, paths, sessionFile, close, recordingDirectory, tmuxSocket,
      captureTmux: async () => (await tmux(['capture-pane', '-p', '-t', `cauce-${alias}:agente`])).stdout,
      tmuxSessionExists: async () => (await tmux(['has-session', '-t', `cauce-${alias}`])).stderr === '',
      loginOutput: login.stdout + login.stderr,
      secrets: [password, relayToken, ticketKey.toString('hex'), tls.key.toString(), session.cookie, session.csrf_token],
      relocate: async () => {
        if (!database) throw new Error('relocation requires the owned database');
        if (options.tui) throw new Error('relocation requires the shell fixture');
        const marker = options.remoteRelocation ? await readFile(join(home, 'move-proof.txt'), 'utf8') : '';
        await stopChild(python);
        const destination = options.remoteRelocation?.destination.container ?? `zz-canary-e2e-a9-cli-1025b-${suffix}`;
        const destinationHome = options.remoteRelocation?.destination.home ?? join(directory, 'destination-home');
        if (!options.remoteRelocation) {
          await mkdir(destinationHome, { mode: 0o700 });
          if (process.getuid?.() === 0) await chown(destinationHome, runtimeUid, runtimeGid);
        }
        const host = options.remoteRelocation?.destination.host ?? `zz-canary-e2e-a9-cli-1025b-${suffix}`;
        await database.pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
          SELECT $1,$1,company_id FROM agents WHERE tenant_id=$2 AND alias=$3`, [host, tenant, alias]);
        await database.pool.query('UPDATE agents SET container_name=$1,host_id=$2,home_directory=$3 WHERE tenant_id=$4 AND alias=$5',
          [destination, host, destinationHome, tenant, alias]);
        const generation = `moved-${suffix}`;
        const movedConfiguration = {
          ...bundleConfiguration,
          container_id: destination, generation, home: destinationHome,
          ...(options.remoteRelocation ? { relay_host: options.remoteRelocation.relayHost } : {}),
        };
        if (options.remoteRelocation) {
          await options.remoteRelocation.start(movedConfiguration, marker);
          const deadline = Date.now() + 90_000;
          while (registry.get(tenant, alias, Date.now())?.presence.container_id !== destination
            || registry.get(tenant, alias, Date.now())?.presence.generation !== generation
            || registry.state(tenant, alias, Date.now()) !== 'online') {
            if (Date.now() >= deadline) throw new Error('remote PTY did not become online');
            await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
          }
          return { container: destination, home: destinationHome, host, generation, sourceExited: python.exitCode !== null || python.signalCode !== null };
        }
        const movedBundle = await privateFile('destination-bundle.json', JSON.stringify(movedConfiguration));
        movedContainers.push(destination);
        const moved = spawn('docker', ['run', '--rm', '--name', destination, '--label', 'cauce.e2e.owner=e2e-a9-cli-1025b',
          '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--user', `${String(runtimeUid)}:${String(runtimeGid)}`,
          '--mount', `type=bind,src=${directory},dst=${directory}`,
          '--mount', `type=bind,src=${join(root, 'ops/pty-agent')},dst=/opt/cauce-pty-agent,readonly`,
          '--workdir', destinationHome, '--env', 'PYTHONPATH=/opt/cauce-pty-agent', '--env', 'PYTHONDONTWRITEBYTECODE=1',
          'python:3.13-slim', 'python3', '-m', 'cauce_pty_agent', '--bundle', movedBundle],
          { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(moved); moved.stdout.on('data', capture); moved.stderr.on('data', capture);
        const deadline = Date.now() + 90_000;
        while (registry.get(tenant, alias, Date.now())?.presence.container_id !== destination
          || registry.state(tenant, alias, Date.now()) !== 'online') {
          if (Date.now() >= deadline || moved.exitCode !== null) throw new Error('relocated PTY did not become online');
          await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        }
        return { container: destination, home: destinationHome, host, generation, sourceExited: python.exitCode !== null || python.signalCode !== null };
      },
      denyTarget: async () => {
        await writeFile(grants, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_100));
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'dynamic PTY fixture failed during setup and cleanup'); }
    throw error;
  }
}

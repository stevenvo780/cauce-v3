import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';

const execute = promisify(execFile);
export interface PtyFleetPki {
  ca: string; server: { cert: string; key: string }; relay: { cert: string; key: string };
  console: { cert: string; key: string }; relayId: string;
}
export interface PtyFleetRelayIdentity { pid: number; starttime: string; state: string }

export async function createPtyFleetPki(directory: string, authority: string): Promise<PtyFleetPki> {
  const ca = join(authority, 'ca.crt');
  const issue = async (name: string, purpose: 'serverAuth' | 'clientAuth') => {
    const key = join(directory, name + '.key'), cert = join(directory, name + '.crt');
    const config = join(directory, name + '.cnf'), csr = join(directory, name + '.csr');
    await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=' + name
      + '\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' + purpose
      + (purpose === 'serverAuth' ? '\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n' : '\n'), { mode: 0o600 });
    await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', config]);
    await chmod(key, 0o600);
    await execute('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', join(authority, 'ca.key'),
      '-CAcreateserial', '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
    return { key, cert };
  };
  const server = await issue('localhost', 'serverAuth'), relay = await issue('relay', 'clientAuth');
  return { ca, server, relay, console: await issue('console', 'clientAuth'),
    relayId: relayInstanceIdFromCertificate(await readFile(relay.cert)) };
}

export async function startPtyFleetRelay(options: {
  directory: string; gatewayUrl: string; registry: string; pki: PtyFleetPki;
  ports: { browser: number; agent: number; health: number }; tokenFile: string;
}): Promise<{ close(): Promise<void>; pause(): Promise<PtyFleetRelayIdentity>; resume(): Promise<PtyFleetRelayIdentity>; log(): string }> {
  const { directory, gatewayUrl, registry, pki, ports, tokenFile } = options;
  let logs = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'services/terminal-relay/src/main.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: pki.ca,
      CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1', CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(ports.browser),
      CAUCE_TERMINAL_RELAY_AGENT_PORT: String(ports.agent), CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(ports.health),
      CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: pki.server.cert, CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: pki.server.key,
      CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: pki.ca, CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console',
      CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: pki.ca, CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: registry,
      CAUCE_TERMINAL_GATEWAY_URL: gatewayUrl, CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile,
      CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: pki.relay.cert, CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: pki.relay.key,
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: pki.relayId, CAUCE_TERMINAL_CLOSE_SPOOL_FILE: join(directory, 'close-spool.json'),
      CAUCE_TERMINAL_RECORDING_DIR: join(directory, 'recordings'), CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1',
      CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1', CAUCE_TERMINAL_PRESENCE_INTERVAL_SECONDS: '1',
    },
  });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString('utf8')).slice(-16 * 1024); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const identity = async (): Promise<PtyFleetRelayIdentity> => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) throw new Error('the owned relay is no longer running');
    const stat = await readFile('/proc/' + String(child.pid) + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const state = fields[0], starttime = fields[19];
    if (!state || !starttime) throw new Error('the owned relay process identity is unavailable');
    return { pid: child.pid, starttime, state };
  };
  const initial = await identity();
  let paused = false;
  const pause = async (wanted: boolean): Promise<PtyFleetRelayIdentity> => {
    const before = await identity();
    if (before.pid !== initial.pid || before.starttime !== initial.starttime) throw new Error('the owned relay process generation changed');
    if (!child.kill(wanted ? 'SIGSTOP' : 'SIGCONT')) throw new Error('the owned relay signal was not accepted');
    paused = wanted;
    for (let attempt = 0; attempt < 20; attempt++) {
      const after = await identity();
      if (after.pid !== initial.pid || after.starttime !== initial.starttime) throw new Error('the owned relay changed during its signal');
      if ((after.state === 'T') === wanted) return after;
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
    throw new Error('the owned relay did not reach its requested process state');
  };
  return { close: async () => { if (paused) await pause(false); await stopPtyFleetRelay(child); },
    pause: () => pause(true), resume: () => pause(false), log: () => logs };
}

async function stopPtyFleetRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const force = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
    const deadline = setTimeout(() => { reject(new Error('owned PTY relay did not stop')); }, 7_000);
    child.once('close', () => { clearTimeout(force); clearTimeout(deadline); resolveStop(); });
    child.kill('SIGTERM');
  });
}

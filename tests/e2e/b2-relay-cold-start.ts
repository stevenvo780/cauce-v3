import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import type { RealPtyFixture } from './real-pty-agent.fixtures.js';

export async function startColdRelay(fixture: RealPtyFixture, spool: string): Promise<() => Promise<void>> {
  const reservations = await reserveNamedLoopbackPorts(['browser', 'agent', 'health']);
  const file = (name: string) => join(fixture.directory, name);
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: file('ca.crt'),
    CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1',
    CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(reservations.ports.browser),
    CAUCE_TERMINAL_RELAY_AGENT_PORT: String(reservations.ports.agent),
    CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(reservations.ports.health),
    CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: file('relay-server.crt'),
    CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: file('relay-server.key'),
    CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: file('ca.crt'), CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console',
    CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: file('ca.crt'),
    CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: file('agent-registry.json'),
    CAUCE_TERMINAL_GATEWAY_URL: fixture.gatewayUrl, CAUCE_TERMINAL_RELAY_TOKEN_FILE: file('relay-token'),
    CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: file('relay-client.crt'),
    CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: file('relay-client.key'),
    CAUCE_TERMINAL_RELAY_INSTANCE_ID: fixture.relayInstanceId, CAUCE_TERMINAL_CLOSE_SPOOL_FILE: spool,
    CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1', CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
  };
  await reservations.releaseAll();
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], {
    cwd: process.cwd(), env: environment, stdio: 'ignore', detached: true,
    ...(process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {}),
  });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  return async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (pid === undefined) throw new Error('cold relay did not expose its owned process id');
    const signal = (name: NodeJS.Signals) => {
      try { process.kill(-pid, name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const exited = new Promise<void>(resolve => { child.once('exit', () => { resolve(); }); });
    signal('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 3_000);
      })]);
      await exited;
    } finally { clearTimeout(timer); }
  };
}

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { runDynamicCli, startDynamicTerminalFixture } from './v4-cli-dynamic-terminal.fixtures.js';

const execute = promisify(execFile);
const configurationOwner = 'e2e-cli-cross-machine-1025';
interface LabConfiguration {
  owner: string; run: string;
  endpoint: string; certFile: string; keyFile: string; relayHost: string;
  sourceDaemonHash: string; destinationDaemonHash: string;
  sourceMachineHash: string; destinationMachineHash: string;
  sourceHost: string; destinationHost: string; destinationContainer: string;
  sourceRelayPort: number; destinationRelayPort: number;
  sourceContext: string; destinationContext: string;
}
interface RemoteStatus { process_alive: boolean; marker_sha256: string | null; pid: number | null; container: string; home: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

it('keeps nominal CLI access and transferred state when a real PTY moves from lab to the independent lab2 machine', async () => {
  const configPath = join(process.cwd(), '.delegados/v4/runtime', `${configurationOwner}-cross-machine.json`);
  const rawConfig = await readFile(configPath, 'utf8').catch(() => {
    throw new Error('cross-machine lab not prepared: run bash tests/e2e/v4-cli-cross-machine.lab.sh --owner b3i2-rojas-infraestructura-1025; this command provisions lab/lab2, runs this suite with scripts/e2e-lab.sh and cleans its resources');
  });
  const config = JSON.parse(rawConfig) as LabConfiguration;
  expect(config.owner).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/u);
  expect(config.run).toMatch(/^[a-f0-9]{12}$/u);
  const owner = config.owner;
  const run = config.run;
  const receipts = join(process.cwd(), '.delegados/v4/recibos', owner, 'cross-analysis/suite', run);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  expect([config.sourceContext, config.destinationContext]).toEqual(['lab', 'lab2']);
  expect(config.sourceMachineHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(config.destinationMachineHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(config.sourceMachineHash).not.toBe(config.destinationMachineHash);
  expect(config.sourceDaemonHash).not.toBe(config.destinationDaemonHash);
  const daemon = await execute('docker', ['info', '--format', '{{.ID}}']);
  expect(digest(daemon.stdout.trim())).toBe(config.sourceDaemonHash);
  expect(config.destinationContainer.startsWith(`zz-canary-${owner}-`)).toBe(true);
  const transport = new Agent({ cert: await readFile(config.certFile), key: await readFile(config.keyFile),
    ca: await readFile(config.certFile), servername: 'localhost', rejectUnauthorized: true });
  const remote = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<RemoteStatus> => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolveResult, reject) => {
      const outgoing = request(new URL(path, config.endpoint), { method, agent: transport,
        headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, incoming => {
        let response = '';
        incoming.on('data', (chunk: Buffer) => {
          response += chunk.toString();
          if (response.length > 64 * 1024) outgoing.destroy(new Error('remote lab response exceeded its bound'));
        });
        incoming.on('end', () => {
          if (incoming.statusCode !== 200) reject(new Error(`remote lab manager returned HTTP ${String(incoming.statusCode)}`));
          else {
            try { resolveResult(JSON.parse(response) as RemoteStatus); }
            catch { reject(new Error('remote lab manager returned invalid JSON')); }
          }
        });
      });
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('remote lab manager exceeded its deadline')));
      outgoing.once('error', reject);
      outgoing.end(payload);
    });
  };
  let active: Awaited<ReturnType<typeof startDynamicTerminalFixture>> | undefined;
  try {
    const initial = await remote('GET', '/status');
    expect(initial.process_alive).toBe(false);
    active = await startDynamicTerminalFixture({ remoteRelocation: { relayHost: config.relayHost, sourceHost: config.sourceHost, sourceRelayPort: config.sourceRelayPort,
      destination: { container: config.destinationContainer, host: config.destinationHost, home: '/state/home' },
      start: async (bundle, marker) => {
        const started = await remote('POST', '/start', { bundle: { ...bundle, relay_port: config.destinationRelayPort }, marker });
        expect(started.process_alive).toBe(true);
      },
    } });
    await writeFile(join(receipts, 'started.json'), JSON.stringify({ owner, run,
      database_container: active.database.container.getId(), destination_container: config.destinationContainer,
    }, null, 2) + '\n', { mode: 0o600 });
    const marker = `STATE_${randomUUID()}`;
    const origin = await runDynamicCli([active.alias], active.sessionFile,
      `printf '%s\\n' '${marker}' > "$HOME/move-proof.txt"; printf 'SOURCE_READY\\n'; exit\n`);
    expect(origin.code, origin.stderr).toBe(0);
    expect(origin.stdout).toMatch(/(?:^|[\r\n])SOURCE_READY\r?\n/u);
    const sourceState = await readFile(join(active.home, 'move-proof.txt'), 'utf8');
    expect(sourceState).toBe(`${marker}\n`);
    const destination = await active.relocate();
    expect(destination.sourceExited).toBe(true);
    const nonce = randomUUID();
    const moved = await runDynamicCli([`${active.tenant}/${active.alias}`], active.sessionFile,
      `cat "$HOME/move-proof.txt"; printf 'DESTINATION_%s\\n' '${nonce}'; printf 'HOME:%s\\n' "$HOME"; exit\n`);
    expect(moved.code, moved.stderr).toBe(0);
    expect(moved.stdout).toMatch(new RegExp(`(?:^|[\\r\\n])${marker}\\r?\\n`, 'u'));
    expect(moved.stdout).toMatch(new RegExp(`(?:^|[\\r\\n])DESTINATION_${nonce}\\r?\\n`, 'u'));
    expect(moved.stdout).toContain('HOME:/state/home');
    const status = await remote('GET', '/status');
    expect(status.process_alive).toBe(true);
    expect(status.marker_sha256).toBe(digest(sourceState));
    expect(status.container).toBe(destination.container);
    expect(status.home).toBe(destination.home);
    const sessions = await active.database.pool.query<{ container: string; generation: string; consumed: boolean; closed: boolean }>(
      `SELECT container,generation,consumed_at IS NOT NULL AS consumed,(closed_at IS NOT NULL OR revoked_at IS NOT NULL) AS closed
       FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 ORDER BY issued_at`, [active.tenant, active.alias]);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows[0]?.container).not.toBe(destination.container);
    expect(sessions.rows[1]).toEqual({ container: destination.container, generation: destination.generation, consumed: true, closed: true });
    const placement = await active.database.pool.query<{ host_id: string }>(
      'SELECT host_id FROM agents WHERE tenant_id=$1 AND alias=$2', [active.tenant, active.alias]);
    expect(placement.rows[0]?.host_id).toBe(config.destinationHost);
    expect(await readFile(join(active.home, 'move-proof.txt'), 'utf8')).toBe(sourceState);
    for (const secret of active.secrets) expect(origin.stdout + origin.stderr + moved.stdout + moved.stderr).not.toContain(secret);
    await writeFile(join(receipts, 'verified.json'), JSON.stringify({ owner, run, source_context: config.sourceContext,
      destination_context: config.destinationContext, source_machine_hash: config.sourceMachineHash, destination_machine_hash: config.destinationMachineHash,
      source_daemon_hash: config.sourceDaemonHash, destination_daemon_hash: config.destinationDaemonHash,
      database_container: active.database.container.getId(), destination_container: destination.container,
      source_process_stopped: destination.sourceExited, transferred_state_sha256: status.marker_sha256,
      destination_nonce_verified: true, source_copy_preserved: true, same_nominal_session: true,
      destination_placement: placement.rows[0], sessions: sessions.rows,
      relocation_scope: 'CLI routing and PTY state transfer across laboratory machines; placement prepared by owned fixture',
    }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`V4_CLI_CROSS_MACHINE ${JSON.stringify({ run, source: 'lab', destination: 'lab2', state_transferred: true, nonce_verified: true })}\n`);
  } finally {
    try { await active?.close(); }
    finally { transport.destroy(); }
  }
}, 240_000);

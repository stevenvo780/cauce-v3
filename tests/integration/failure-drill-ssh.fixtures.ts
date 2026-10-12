import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { FleetSshTransport } from '../../services/gateway/src/fleet/host-transport.js';
import type { DatabasePool } from '@cauce/store';
import { objectRecord } from '@cauce/protocol';
import { redactExecutorStderr } from '../../services/gateway/src/fleet/host-stderr.js';

const execute = promisify(execFile);
const hash = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');

interface FleetSweepReport {
  clean: boolean; sweep_exit: 0 | 1;
  orphan_resources: { kind: string; name: string; runtime_key: string | null }[];
  orphan_named_resources: { kind: string; name: string }[];
  orphan_rows: { runtime_key: string; container_name: string }[];
}
function isFleetSweepReport(value: unknown): value is FleetSweepReport {
  const report = objectRecord(value);
  return report !== undefined && typeof report.clean === 'boolean' && (report.sweep_exit === 0 || report.sweep_exit === 1)
    && Array.isArray(report.orphan_resources) && report.orphan_resources.every((value: unknown) => {
      const row = objectRecord(value);
      return row !== undefined && typeof row.kind === 'string' && typeof row.name === 'string'
        && (typeof row.runtime_key === 'string' || row.runtime_key === null);
    }) && Array.isArray(report.orphan_named_resources) && report.orphan_named_resources.every((value: unknown) => {
      const row = objectRecord(value);
      return row !== undefined && typeof row.kind === 'string' && typeof row.name === 'string';
    }) && Array.isArray(report.orphan_rows) && report.orphan_rows.every((value: unknown) => {
      const row = objectRecord(value);
      return row !== undefined && typeof row.runtime_key === 'string' && typeof row.container_name === 'string';
    });
}
export async function sweepDatabaseFleet(pool: DatabasePool, directory: string, prefix: string, host: string) {
  const rows = (await pool.query(`SELECT runtime_key,container_name,runtime_mode,host_id FROM agents
    WHERE purged_at IS NULL AND host_id=$1 AND left(runtime_key,length($2::text))=$2`, [host, prefix])).rows;
  const filename = join(directory, 'orphan-rows.json');
  await writeFile(filename, JSON.stringify(rows), { mode: 0o600 });
  const program = [
    'import json,pathlib,sys',
    `sys.path.insert(0,${JSON.stringify(resolve(import.meta.dirname, '../../ops/tests'))})`,
    'from test_fleet_executor_container import sweep_owned_fleet',
    'report=sweep_owned_fleet(sys.argv[1],json.loads(pathlib.Path(sys.argv[1]).read_text()),sys.argv[2],sys.argv[3])',
    'print(json.dumps(report));sys.exit(0 if report["clean"] else 1)',
  ].join('\n');
  let stdout: string;
  let stderr: string;
  let exitCode = 0;
  try { ({ stdout, stderr } = await execute('/usr/bin/python3', ['-c', program, filename, prefix, host], { timeout: 75_000 })); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string'
      && 'stderr' in error && typeof error.stderr === 'string')) throw error;
    stdout = error.stdout; stderr = error.stderr; exitCode = 1;
  }
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); }
  catch { throw new Error(`Fleet orphan sweep infrastructure failed exit=${String(exitCode)} stdout_bytes=${String(Buffer.byteLength(stdout))} stderr=${redactExecutorStderr(stderr).slice(-4096)}`); }
  if (!isFleetSweepReport(decoded)) throw new Error('Fleet orphan sweep report is malformed');
  const report = decoded;
  if (exitCode !== Number(!report.clean)) throw new Error('Fleet orphan sweep exit does not match its report');
  if (stderr.trim()) console.info(redactExecutorStderr(stderr));
  console.info(`FLEET_ORPHAN_SWEEP scope=${prefix} exit=${String(exitCode)} clean=${String(report.clean)} resources=${String(report.orphan_resources.length)} rows=${String(report.orphan_rows.length)} named=${String(report.orphan_named_resources.length)}`);
  return { exitCode, report };
}

export async function contents(filename: string): Promise<string> {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
}

async function children(pid: number): Promise<number[]> {
  const list = await contents(`/proc/${String(pid)}/task/${String(pid)}/children`);
  const direct = list.trim().split(/\s+/u).filter(Boolean).map(Number);
  const nested = await Promise.all(direct.map(children));
  return [...direct, ...nested.flat()];
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

export interface PrivateSshFixture {
  directory: string;
  transport: FleetSshTransport;
  start(): Promise<void>;
  interrupt(): Promise<number[]>;
  close(): Promise<void>;
}

export async function privateSshFixture(): Promise<PrivateSshFixture> {
  const directory = await mkdtemp(join(userInfo().homedir, 'zz-canary-ssh-'));
  let daemon: ChildProcess | undefined;
  let diagnostics = '';
  const close = async () => {
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const descendants = await children(daemon.pid);
      for (const pid of descendants.reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      await stopProcess(daemon);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const server = createServer();
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Private SSH fixture port is absent');
    const port = address.port;
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    for (const name of ['server-key', 'client-key']) {
      await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
    }
    await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
    const config = [
      `Port ${String(port)}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'server-key')}`,
      `PidFile ${join(directory, 'sshd.pid')}`, `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`,
      'StrictModes yes', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', `AllowUsers ${userInfo().username}`, 'LogLevel ERROR', '',
    ].join('\n');
    await writeFile(join(directory, 'sshd.conf'), config, { mode: 0o600 });
    const hostKey = (await readFile(join(directory, 'server-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    const knownHosts = `[127.0.0.1]:${String(port)} ${hostKey}\n`;
    await writeFile(join(directory, 'known_hosts'), knownHosts, { mode: 0o600 });
    const transport: FleetSshTransport = {
      executable: '/usr/bin/ssh', executable_sha256: hash(await readFile('/usr/bin/ssh')),
      destination: `${userInfo().username}@127.0.0.1`, port,
      known_hosts_file: join(directory, 'known_hosts'), known_hosts_sha256: hash(knownHosts),
      identity_file: join(directory, 'client-key'), identity_sha256: hash(await readFile(join(directory, 'client-key'))),
    };
    const start = async () => {
      daemon = spawn('/usr/bin/sshd', ['-D', '-f', join(directory, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
      daemon.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`Private SSH fixture exited: ${diagnostics}`);
        const ready = await new Promise<boolean>(resolve => {
          const socket = connect(port, '127.0.0.1');
          socket.once('error', () => { socket.destroy(); resolve(false); });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
        });
        if (ready) return;
        await delay(20);
      }
      throw new Error(`Private SSH fixture did not listen: ${diagnostics}`);
    };
    const interrupt = async () => {
      if (!daemon?.pid || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Private SSH daemon is absent');
      const interrupted = [daemon.pid, ...await children(daemon.pid)];
      for (const pid of interrupted.slice(1).reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      await stopProcess(daemon);
      return interrupted;
    };
    await start();
    return { directory, transport, start, interrupt, close };
  } catch (error) { await close(); throw error; }
}

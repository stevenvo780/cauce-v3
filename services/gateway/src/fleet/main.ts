import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@cauce/store';
import { performHostCommand, performHostCompensation, type HostCommandConfig } from './host-command.js';
import { FleetHostSource } from './source.js';
import { FleetHostWorker } from './worker.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { createHostProviderAuthService } from './host-provider-auth.js';

export interface FleetHostConfig {
  projectRoot: string; databaseFile: string; host: string; worker: string; command: HostCommandConfig;
  pollMs: number; leaseMs: number;
  auth?: { socket: string; policyFile: string; groupGid?: number };
}
function invalid(): Error { return new Error('Fleet host configuration is invalid'); }
function path(value: string | undefined): string {
  if (!value || !isAbsolute(value) || normalize(value) !== value || /[\p{Cc}]/u.test(value)) throw invalid();
  return value;
}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value !== undefined && !/^\d+$/u.test(value)) throw invalid();
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalid();
  return parsed;
}
export function readFleetHostConfig(environment: NodeJS.ProcessEnv): FleetHostConfig {
  const host = environment.CAUCE_FLEET_HOST; const worker = environment.CAUCE_FLEET_WORKER_ID;
  if (!host || !/^[a-z][a-z0-9_-]{0,63}$/u.test(host) || !worker || !/^[a-zA-Z0-9_-]{1,128}$/u.test(worker)) throw invalid();
  const hasAuth = environment.CAUCE_FLEET_API_SOCKET !== undefined || environment.CAUCE_FLEET_AUTH_POLICY_FILE !== undefined;
  const auth = hasAuth ? { socket: path(environment.CAUCE_FLEET_API_SOCKET), policyFile: path(environment.CAUCE_FLEET_AUTH_POLICY_FILE),
    ...(environment.CAUCE_FLEET_API_GROUP_GID === undefined ? {} : {
      groupGid: integer(environment.CAUCE_FLEET_API_GROUP_GID, 0, 1, 2_147_483_647),
    }) } : undefined;
  if (!hasAuth && environment.CAUCE_FLEET_API_GROUP_GID !== undefined) throw invalid();
  return { projectRoot: path(environment.CAUCE_FLEET_PROJECT_ROOT), databaseFile: path(environment.CAUCE_FLEET_DATABASE_URL_FILE), host, worker,
    command: { python: path(environment.CAUCE_FLEET_PYTHON), executable: path(environment.CAUCE_FLEET_EXECUTABLE),
      policyFile: path(environment.CAUCE_FLEET_POLICY_FILE), timeoutMs: integer(environment.CAUCE_FLEET_COMMAND_TIMEOUT_MS, 60_000, 1, 300_000) },
    pollMs: integer(environment.CAUCE_FLEET_POLL_MS, 1000, 25, 60_000), leaseMs: integer(environment.CAUCE_FLEET_LEASE_MS, 30_000, 1000, 300_000),
    ...(auth === undefined ? {} : { auth }) };
}
export async function readFleetHostDatabaseUrl(filename: string): Promise<string> {
  try {
    const file = await open(path(filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat(); const uid = process.geteuid?.();
      if (!metadata.isFile() || uid === undefined || metadata.uid !== uid || metadata.nlink !== 1
          || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384) throw invalid();
      const encoded = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(encoded, 0, encoded.length, 0);
      if (bytesRead > 16_384) throw invalid();
      const value = encoded.subarray(0, bytesRead).toString('utf8').trim(); const url = new URL(value);
      if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash || /[\p{Cc}]/u.test(value)) throw invalid();
      return value;
    } finally { await file.close(); }
  } catch { throw new Error('Fleet host database configuration is unavailable'); }
}
export async function runFleetHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readFleetHostConfig(environment);
  const databaseUrl = await readFleetHostDatabaseUrl(config.databaseFile);
  let snapshotQuery: string;
  try { snapshotQuery = await readFile(join(config.projectRoot, 'ops/scripts/fleet-query.sql'), 'utf8'); }
  catch { throw new Error('Fleet host snapshot query is unavailable'); }
  const pool = createPool(databaseUrl, { applicationName: 'cauce-fleet-host', max: 4 });
  let bridge: Awaited<ReturnType<typeof startAuthBridge>> | undefined;
  if (config.auth) {
    try {
      const service = await createHostProviderAuthService(pool, { hostConfig: config, authPolicyFile: config.auth.policyFile,
        projectRoot: config.projectRoot });
      bridge = await startAuthBridge(config.auth.socket, service, { ownerUid: process.geteuid?.() ?? 0,
        ...(config.auth.groupGid === undefined ? {} : { groupGid: config.auth.groupGid }) });
    } catch (error) { await pool.end(); throw error; }
  }
  const source = new FleetHostSource(pool, { snapshotQuery, controllerHost: config.host });
  const worker = new FleetHostWorker(source, { worker: config.worker, host: config.host, leaseMs: config.leaseMs, pollMs: config.pollMs,
    perform: (step, execution, signal) => performHostCommand(config.command, step, execution, signal),
    compensate: (execution, signal) => performHostCompensation(config.command, execution, signal),
    onError: () => { process.stderr.write('Fleet host could not claim work\n'); } });
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= worker.shutdown().finally(async () => { try { await bridge?.close(); } finally { await pool.end(); } });
    return closing;
  };
  const stop = () => { void shutdown().catch(() => { process.stderr.write('Fleet host shutdown failed\n'); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await worker.start(); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await shutdown(); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runFleetHost().catch(() => { process.stderr.write('Fleet host startup failed\n'); process.exitCode = 1; });
}

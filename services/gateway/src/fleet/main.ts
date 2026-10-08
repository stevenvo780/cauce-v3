import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, recordFleetHostStatus } from '@cauce/store';
import { performHostCommand, performHostCompensation, type HostCommandConfig } from './host-command.js';
import { FleetHostSource } from './source.js';
import { FleetHostWorker } from './worker.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { createHostProviderAuthService } from './host-provider-auth.js';
import { readFleetControllerConfig, createFleetControllerTransport } from './controller-config.js';
import { FleetCoordinator } from './coordinator.js';
import { createFleetAuthorityService } from './authority/service.js';
import { startFleetAuthoritySocket } from './authority/socket.js';
import { startFleetHostChannels } from './host-channels.js';
import { guardFleetTransport } from './host-availability.js';
import { createLegacyAdoptionProbe } from './legacy-adoption-probe.js';
import { startLegacyAdoptionBridge } from './adoption-bridge-server.js';
import { drainLegacyFleetTransaction } from './adoption-drain.js';

const CONTROLLER_HEARTBEAT_MS = 30_000;

export interface FleetHostConfig {
  projectRoot: string; databaseFile: string; host: string; worker: string; command: HostCommandConfig;
  pollMs: number; leaseMs: number;
  auth?: { socket: string; policyFile: string; groupGid?: number };
  controllerFile?: string;
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
    ...(auth === undefined ? {} : { auth }),
    ...(environment.CAUCE_FLEET_CONTROLLER_FILE === undefined ? {} : { controllerFile: path(environment.CAUCE_FLEET_CONTROLLER_FILE) }) };
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
  const controller = config.controllerFile === undefined ? undefined : await readFleetControllerConfig(config.controllerFile, config.host);
  let snapshotQuery: string;
  try { snapshotQuery = await readFile(join(config.projectRoot, 'ops/scripts/fleet-query.sql'), 'utf8'); }
  catch { throw new Error('Fleet host snapshot query is unavailable'); }
  const pool = createPool(databaseUrl, { applicationName: 'cauce-fleet-host', max: 4 });
  let bridge: Awaited<ReturnType<typeof startAuthBridge>> | undefined;
  let channels: Awaited<ReturnType<typeof startFleetHostChannels>> | undefined;
  let adoptionBridge: Awaited<ReturnType<typeof startLegacyAdoptionBridge>> | undefined;
  const adoptionDrainPool = controller?.adoption_socket === undefined ? undefined
    : createPool(databaseUrl, { applicationName: 'cauce-fleet-adoption-drain', max: 1 });
  const channelState = { lost: false };
  const guard = controller === undefined ? undefined : guardFleetTransport(createFleetControllerTransport(controller),
    host => channels?.isHostAvailable(host) ?? true);
  let stopWorker = () => { channelState.lost = true; };
  const authorities: Awaited<ReturnType<typeof startFleetAuthoritySocket>>[] = [];
  try {
    if (controller?.authority_command) {
      for (const host of controller.hosts) {
        if (host.authority_socket === undefined) throw invalid();
        const service = createFleetAuthorityService(pool, { host_id: host.host_id, command: controller.authority_command });
        authorities.push(await startFleetAuthoritySocket(host.authority_socket, service, { ownerUid: process.geteuid?.() ?? 0, host_id: host.host_id }));
      }
    }
  } catch (error) { await Promise.all(authorities.map(authority => authority.close())); await adoptionDrainPool?.end(); await pool.end(); throw error; }
  if (config.auth) {
    try {
      const service = await createHostProviderAuthService(pool, { hostConfig: config, authPolicyFile: config.auth.policyFile,
        projectRoot: config.projectRoot });
      bridge = await startAuthBridge(config.auth.socket, service, { ownerUid: process.geteuid?.() ?? 0,
        ...(config.auth.groupGid === undefined ? {} : { groupGid: config.auth.groupGid }) });
    } catch (error) { await Promise.all(authorities.map(authority => authority.close())); await adoptionDrainPool?.end(); await pool.end(); throw error; }
  }
  try {
    if (controller) channels = await startFleetHostChannels(controller, { onLost: () => { channelState.lost = true; stopWorker(); },
      onHostDown: hostId => { guard?.abortHost(hostId); },
      onHostStatus: async (hostId, status) => {
        try { await recordFleetHostStatus(pool, hostId, status); }
        catch { process.stderr.write('Fleet host status could not be recorded\n'); }
      },
      ...(config.auth?.groupGid === undefined ? {} : { authGroupGid: config.auth.groupGid }) });
    if (controller?.adoption_socket !== undefined && adoptionDrainPool !== undefined) {
      const probe = createLegacyAdoptionProbe(controller.hosts.flatMap(host => host.adoption === undefined ? [] : [{
        hostId: host.host_id, python: host.command.python, executable: host.adoption.executable,
        policyFile: host.adoption.policyFile, targets: host.adoption.targets,
        ...(host.command.timeoutMs === undefined ? {} : { timeoutMs: host.command.timeoutMs }),
        ...(host.command.transport === undefined ? {} : { transport: host.command.transport }),
      }]));
      adoptionBridge = await startLegacyAdoptionBridge(controller.adoption_socket, probe, { ownerUid: process.geteuid?.() ?? 0,
        ...(controller.adoption_group_gid === undefined ? {} : { groupGid: controller.adoption_group_gid }) },
      { drain: () => drainLegacyFleetTransaction(adoptionDrainPool) });
    }
  } catch (error) {
    await channels?.close(); await bridge?.close(); await Promise.all(authorities.map(authority => authority.close()));
    await adoptionDrainPool?.end(); await pool.end(); throw error;
  }
  const source = new FleetHostSource(pool, { snapshotQuery, controllerHost: config.host, coordinatorEnabled: controller !== undefined,
    ...(controller === undefined ? {} : { coordinatorHosts: controller.hosts.map(host => host.host_id) }) });
  const coordinator = guard === undefined ? undefined : new FleetCoordinator(source, guard.transport);
  const worker = new FleetHostWorker(source, { worker: config.worker, host: config.host, leaseMs: config.leaseMs, pollMs: config.pollMs,
    perform: (step, execution, signal, claim) => coordinator === undefined ? performHostCommand(config.command, step, execution, signal)
      : coordinator.perform(step, execution, signal, claim),
    compensate: (execution, signal, claim) => coordinator === undefined ? performHostCompensation(config.command, execution, signal)
      : coordinator.compensate(execution, signal, claim),
    onError: () => { process.stderr.write('Fleet host could not claim work\n'); } });
  let heartbeat: NodeJS.Timeout | undefined;
  if (controller) {
    const beat = async (): Promise<void> => {
      try {
        await recordFleetHostStatus(pool, config.host, 'reachable');
        for (const host of controller.hosts) {
          if (host.host_id === config.host) continue;
          await recordFleetHostStatus(pool, host.host_id, (channels?.isHostAvailable(host.host_id) ?? true) ? 'reachable' : 'unreachable');
        }
      } catch { process.stderr.write('Fleet host heartbeat could not be recorded\n'); }
    };
    void beat();
    heartbeat = setInterval(() => { void beat(); }, CONTROLLER_HEARTBEAT_MS); heartbeat.unref();
  }
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (heartbeat) clearInterval(heartbeat);
    closing ??= worker.shutdown().finally(async () => {
      try {
        await adoptionBridge?.close(); await channels?.close(); await bridge?.close();
        await Promise.all(authorities.map(authority => authority.close()));
      } finally { await adoptionDrainPool?.end(); await pool.end(); }
    });
    return closing;
  };
  const stop = () => { void shutdown().catch(() => { process.stderr.write('Fleet host shutdown failed\n'); process.exitCode = 1; }); };
  stopWorker = stop;
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { if (channelState.lost) throw new Error('Fleet host private channel was lost'); await worker.start(); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await shutdown(); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runFleetHost().catch(() => { process.stderr.write('Fleet host startup failed\n'); process.exitCode = 1; });
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAuthService } from '../console/provider-auth.types.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { createHostProviderAuthService } from './host-provider-auth.js';
import { readFleetHostConfig, readFleetHostDatabaseUrl } from './main.js';
import { createFleetAuthDatabasePool } from './fleet-database.js';

export async function runFleetAuthHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readFleetHostConfig(environment);
  if (!config.auth || config.controllerFile !== undefined) throw new Error('Fleet authentication host configuration is invalid');
  const databaseUrl = await readFleetHostDatabaseUrl(config.databaseFile);
  const pool = createFleetAuthDatabasePool(databaseUrl, environment);
  let service: ProviderAuthService | undefined;
  let bridge: Awaited<ReturnType<typeof startAuthBridge>> | undefined;
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>(done => { stop = done; });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    service = await createHostProviderAuthService(pool, { hostConfig: config,
      authPolicyFile: config.auth.policyFile, projectRoot: config.projectRoot });
    bridge = await startAuthBridge(config.auth.socket, service, { ownerUid: process.geteuid?.() ?? 0,
      ...(config.auth.groupGid === undefined ? {} : { groupGid: config.auth.groupGid }) });
    await stopped;
  } finally {
    try {
      if (bridge) await bridge.close(); else await service?.shutdown();
    } finally {
      try { await pool.end(); }
      finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
    }
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runFleetAuthHost().catch(() => { process.stderr.write('Fleet authentication host startup failed\n'); process.exitCode = 1; });
}

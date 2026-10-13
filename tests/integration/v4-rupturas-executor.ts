import { readFile } from 'node:fs/promises';
import { createPool } from '@cauce/store';
import { FleetExecutor } from '../../services/gateway/src/fleet/executor.js';
import { performHostCommand, type HostCommandConfig } from '../../services/gateway/src/fleet/host-command.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';

const config = JSON.parse(process.env.CAUCE_RUPTURE_CONFIG ?? '{}') as {
  url: string; host: string; command: HostCommandConfig;
};
if (!new URL(config.url).pathname.startsWith('/cauce_test') || !config.host.startsWith('zz-canary-')) {
  throw new Error('Rupture worker requires its isolated database and canary host');
}
const pool = createPool(config.url);
try {
  const source = new FleetHostSource(pool, { controllerHost: config.host,
    snapshotQuery: await readFile(new URL('../../ops/scripts/fleet-query.sql', import.meta.url), 'utf8') });
  const executor = new FleetExecutor(source, { host: config.host, worker: 'zz-canary-rupture-worker', leaseMs: 5000,
    perform: (step, packet, signal) => performHostCommand(config.command, step, packet, signal) });
  await executor.runOnce();
} finally { await pool.end(); }

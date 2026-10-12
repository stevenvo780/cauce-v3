import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, FleetOperationsRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { FleetCoordinator } from '../../services/gateway/src/fleet/coordinator.js';
import { FleetHostWorker } from '../../services/gateway/src/fleet/worker.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';

const config = JSON.parse(process.env.CAUCE_FAILURE_DRILL_CONFIG ?? '{}') as {
  url: string; host: string; name: string; checkpoint: string; release: string;
};
if (!new URL(config.url).pathname.startsWith('/cauce_test') || !config.name.startsWith('zz-canary-')) {
  throw new Error('Failure drill requires an isolated database and canary runtime');
}
const pool = createPool(config.url);
const repository = new FleetOperationsRepository(pool);
const execute = promisify(execFile);
if (process.argv[2] === 'gateway') {
  const app = await buildGateway({ pool, logger: false, consoleOrigins: ['https://zz-canary.example.test'],
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 93) }),
    fleetOperationsRepository: repository });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  process.stdout.write(`ready ${address}\n`);
} else if (process.argv[2] === 'worker') {
  const source = new FleetHostSource(pool, { controllerHost: config.host,
    snapshotQuery: await readFile(new URL('../../ops/scripts/fleet-query.sql', import.meta.url), 'utf8') });
  const coordinator = new FleetCoordinator(source, {
    async perform(_host, step, execution, signal) {
      if (step === 'artifacts') {
        if (!execution.snapshot) throw new Error('Canary fleet snapshot is absent');
        const body = JSON.stringify(execution.snapshot);
        await writeFile(`${config.checkpoint}.snapshot.json`, body);
        return { evidence: { artifact_sha256: createHash('sha256').update(body).digest('hex') } };
      }
      if (step !== 'stop') throw new Error('Stop drill encountered an unexpected physical step');
      const target = execution.previous_agents?.find(agent => agent.container_name === config.name);
      if (!target) throw new Error('Canary runtime is outside the operation scope');
      const before = await execute('docker', ['inspect', '--format', '{{.State.Running}}', config.name], { signal });
      if (before.stdout.trim() === 'true') await execute('docker', ['stop', '--time', '1', config.name], { signal });
      const after = await execute('docker', ['inspect', '--format', '{{.State.Running}}', config.name], { signal });
      if (after.stdout.trim() !== 'false') throw new Error('Canary runtime did not stop');
      const pending = `${config.checkpoint}.${String(process.pid)}.tmp`;
      await writeFile(pending, JSON.stringify({ operation: execution.operation.id, epoch: execution.fleet_scope?.claim_epoch }));
      await rename(pending, config.checkpoint);
      for (;;) {
        signal.throwIfAborted();
        try { await access(config.release); break; } catch { await delay(50, undefined, { signal }); }
      }
      return { evidence: { stopped_verified: true } };
    },
    async compensate() { throw new Error('Stop drill does not request compensation'); },
  });
  const worker = new FleetHostWorker(source, { worker: `zz-canary-worker-${String(process.pid)}`,
    host: config.host, leaseMs: 1_000, pollMs: 50,
    perform: coordinator.perform.bind(coordinator), compensate: coordinator.compensate.bind(coordinator) });
  process.stdout.write('ready worker\n');
  await worker.start();
} else {
  await pool.end();
  throw new Error('Unknown failure drill process');
}

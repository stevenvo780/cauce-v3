import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHarness } from '@cauce/adapter-sdk';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { createDefaultJobHandlerRegistry, runDispatcher } from '../../services/dispatcher/src/index.js';
import {
  dockerTestRequirement,
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';

const execute = promisify(execFile);
let database: TestDatabase;
let app: Awaited<ReturnType<typeof buildGateway>>;
let stopDispatcher: (() => void) | undefined;
let httpUrl: string;
const databaseRequirement = dockerTestRequirement(
  'live gateway, dispatcher, adapter, fault, restart, fairness, and message-roundtrip E2E behavior against ephemeral PostgreSQL',
);
let setupPromise: Promise<void> | undefined;
let setupReady = false;

interface DatabaseImageBinding {
  role: 'postgresql-test-dependency';
  repositoryDigest: string;
  imageId: string;
  containerConfigImage: string;
  containerIdSha256: string;
  verifiedAgainstRunningContainer: true;
}

let databaseImageBinding: DatabaseImageBinding | undefined;

interface AdapterScenario {
  name: string;
  status: string;
  evidence: string;
  evidenceClass: string;
  adapterExecutables: string[];
  controlledHarnessExecutables: boolean;
  receipt?: {
    evidenceClass: string;
    adapters: Record<string, number>;
    identities: { tenant: string; room: string; alias: string; harness: string;
      descriptorSha256: string; leaseEpoch: number }[];
    correlation: Record<string, string>;
    nonceSha256: string;
    fanoutBranches: number;
    concurrentBarrier: boolean;
    duplicateSuppressed: boolean;
    mutatedDuplicateRejected: boolean;
    crossTenantIsolation: string;
    finalOriginRelaysForRoundTrip: number;
    cleanup: { processGroupsStopped: boolean; temporaryRootRemoved: boolean };
  };
}

async function setupSuite(): Promise<void> {
  const startedDatabase = await startTestDatabase();
  let startedApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let startedDispatcher: (() => void) | undefined;
  try {
    if (process.env.CAUCE_EVIDENCE_CLASS === 'testcontainers') {
      databaseImageBinding = await inspectDatabaseImage(startedDatabase);
      process.env.CAUCE_TESTCONTAINERS_DB_REPOSITORY_DIGEST = databaseImageBinding.repositoryDigest;
      process.env.CAUCE_TESTCONTAINERS_DB_IMAGE_ID = databaseImageBinding.imageId;
      process.env.CAUCE_TESTCONTAINERS_DB_CONFIG_IMAGE = databaseImageBinding.containerConfigImage;
      process.env.CAUCE_TESTCONTAINERS_DB_CONTAINER_ID_SHA256 = databaseImageBinding.containerIdSha256;
    }
    startedApp = await buildGateway({
      pool: startedDatabase.pool,
      authProvider: DevOnlyAuthProvider.forTests(),
      leaseTtlMs: 30_000,
      outboxPollMs: 10,
      allowedJobKinds: ['system.database.probe', 'qa.fairness'],
    });
    await startedApp.listen({ host: '127.0.0.1', port: 0 });
    const address = startedApp.server.address() as AddressInfo;
    startedDispatcher = runDispatcher(startedDatabase.pool, {
      pollMs: 20,
      staleAckMs: 50,
      interactiveBurst: 3,
      jobLeaseMs: 500,
      handlers: createDefaultJobHandlerRegistry(startedDatabase.pool, 'test'),
    }).stop;
    database = startedDatabase;
    app = startedApp;
    stopDispatcher = startedDispatcher;
    httpUrl = `http://127.0.0.1:${String(address.port)}`;
    setupReady = true;
  } catch (error) {
    startedDispatcher?.();
    await startedApp?.close().catch(() => undefined);
    await startedDatabase.pool.end().catch(() => undefined);
    await startedDatabase.container.stop().catch(() => undefined);
    clearDatabaseImageBindings();
    throw error;
  }
}

beforeEach(async ({ skip }) => {
  if (setupPromise === undefined) {
    if (!process.env.CAUCE_TEST_DATABASE_URL) {
      await databaseRequirement.skipIfUnavailable(skip);
    }
    setupPromise = setupSuite();
  }
  await setupPromise;
}, 120_000);

afterAll(async () => {
  if (setupReady) {
    stopDispatcher?.();
    await app.close();
    await database.pool.end();
    await database.container.stop();
  }
  clearDatabaseImageBindings();
});

function clearDatabaseImageBindings(): void {
  for (const key of [
    'CAUCE_TESTCONTAINERS_DB_REPOSITORY_DIGEST', 'CAUCE_TESTCONTAINERS_DB_IMAGE_ID',
    'CAUCE_TESTCONTAINERS_DB_CONFIG_IMAGE', 'CAUCE_TESTCONTAINERS_DB_CONTAINER_ID_SHA256',
  ]) Reflect.deleteProperty(process.env, key);
}

async function inspectDatabaseImage(targetDatabase: TestDatabase): Promise<DatabaseImageBinding> {
  const containerId = targetDatabase.container.getId();
  const container = JSON.parse((await execute(
    'docker', ['inspect', '--format', '{{json .}}', containerId], { maxBuffer: 1024 * 1024 },
  )).stdout) as { Image?: unknown; Config?: { Image?: unknown } };
  if (typeof container.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(container.Image)
      || typeof container.Config?.Image !== 'string' || !container.Config.Image) {
    throw new Error('running Testcontainers database has no exact Docker image identity');
  }
  const repositoryDigests = JSON.parse((await execute(
    'docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', container.Image], { maxBuffer: 1024 * 1024 },
  )).stdout) as unknown;
  if (!Array.isArray(repositoryDigests)) throw new Error('Testcontainers database image has no RepoDigests');
  const raw = repositoryDigests.find((value): value is string =>
    typeof value === 'string' && /(?:^|\/)postgres@sha256:[a-f0-9]{64}$/u.test(value));
  if (!raw) throw new Error('Testcontainers PostgreSQL image is not repository-digest recoverable');
  const repositoryDigest = raw.startsWith('postgres@') ? `docker.io/library/${raw}` : raw;
  return {
    role: 'postgresql-test-dependency',
    repositoryDigest,
    imageId: container.Image,
    containerConfigImage: container.Config.Image,
    containerIdSha256: `sha256:${createHash('sha256').update(containerId).digest('hex')}`,
    verifiedAgainstRunningContainer: true,
  };
}

function sourceDigest(domain: 'runtime' | 'testcontainers'): string {
  const value = execFileSync('python3', [
    'ops/scripts/source-digest.py', '--domain', domain,
  ], { cwd: process.cwd(), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' }).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid ${domain} source digest`);
  return value;
}

function testcontainersBindings() {
  if (process.env.CAUCE_EVIDENCE_CLASS !== 'testcontainers') return {};
  if (!databaseImageBinding) throw new Error('Testcontainers database image binding is unavailable');
  return {
    evidenceClass: 'testcontainers-source-execution',
    executionTarget: {
      application: 'source-tree',
      database: 'immutable-testcontainer-image',
      finalCauceImageExecuted: false,
    },
    sourceDigest: sourceDigest('runtime'),
    sourceDigestDomain: 'runtime',
    harnessDigest: sourceDigest('testcontainers'),
    harnessDigestDomain: 'testcontainers',
    databaseImage: databaseImageBinding,
  };
}

describe('real external QA harness', () => {
  it('registers and executes packaged fake2 with its own identity and a correlated final reply', async () => {
    await resetTestDatabase(database.pool);
    await declareHarnessFleet();
    const modulePath = '../../ops/harness/adapter-roundtrip.mjs';
    const { runAdapterRoundTrip } = await import(modulePath) as {
      runAdapterRoundTrip: (options: { baseUrl: string; wsBaseUrl: string }) => Promise<{
        adapters: Record<string, number>;
        identities: { tenant: string; alias: string; harness: string; descriptorSha256: string; leaseEpoch: number }[];
        cleanup: { processGroupsStopped: boolean; temporaryRootRemoved: boolean };
        finalOriginRelaysForRoundTrip: number;
      }>;
    };
    const receipt = await runAdapterRoundTrip({ baseUrl: httpUrl, wsBaseUrl: `${httpUrl.replace('http:', 'ws:')}/v3/ws` });
    expect(receipt.adapters).toEqual({ opencode: 1, fake: 3, fake2: 1 });
    const fake2 = receipt.identities.find((identity) => identity.harness === 'fake2');
    const descriptor = await readFile('packages/adapter-sdk/descriptors/fake2.json');
    expect(fake2).toMatchObject({ tenant: 'Steven', alias: 'qa-reviewer-b', harness: 'fake2',
      descriptorSha256: createHash('sha256').update(descriptor).digest('hex') });
    expect(fake2?.leaseEpoch).toBeGreaterThan(0);
    const rows = await database.pool.query<{ harness_id: string; status: string }>(
      `SELECT a.harness_id,d.status FROM agents a JOIN deliveries d
         ON d.recipient_tenant=a.tenant_id AND d.recipient_alias=a.alias
       WHERE a.tenant_id='Steven' AND a.alias='qa-reviewer-b'`,
    );
    expect(rows.rows).toEqual([{ harness_id: 'fake2', status: 'done' }]);
    expect(receipt.finalOriginRelaysForRoundTrip).toBe(1);
    expect(receipt.cleanup).toEqual({ processGroupsStopped: true, temporaryRootRemoved: true });
    await mkdir('ops/artifacts/real', { recursive: true });
    await writeFile('ops/artifacts/real/fake2-roundtrip.json', `${JSON.stringify({
      schemaVersion: 1, ...testcontainersBindings(), ...receipt, durableDeliveries: rows.rows,
    }, null, 2)}\n`);
  }, 120_000);

  it('passes against Fastify WebSocket and PostgreSQL and emits evidence', async () => {
    await resetTestDatabase(database.pool);
    await declareHarnessFleet();
    // `execFile` rejects with "Command failed: <argv>" and leaves the real stdout/stderr hanging
    // on error properties that nobody prints. That causeless message is what made this suite
    // look like a mystery for four days: the harness DID say which check fell over.
    const { stdout, stderr } = await execute(process.execPath, [
      'ops/harness/runner.mjs', '--live', '--artifact-dir', 'ops/artifacts/real',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CAUCE_BASE_URL: httpUrl,
        CAUCE_WS_URL: `${httpUrl.replace('http:', 'ws:')}/v3/ws`,
        CAUCE_FAULT_MODE: 'none',
        CAUCE_ADAPTER_ROUNDTRIP_CONFIRM: 'ephemeral-only',
        CAUCE_PRESENCE_LEASE_MS: '500',
        CAUCE_RETRY_TIMEOUT_MS: '45000',
      },
      timeout: 170_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(async (error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string };
      const recovery = await database.pool.query<{
        status: string;
        attempt: number;
        max_attempts: number;
        available_in_seconds: string;
        claimed: boolean;
        last_error: string | null;
      }>(
        `SELECT status,attempt,max_attempts,
                round(EXTRACT(EPOCH FROM (available_at-now())))::text AS available_in_seconds,
                consumer_instance_id IS NOT NULL AS claimed,last_error
           FROM deliveries
          WHERE status NOT IN ('done','failed','dead')
          ORDER BY created_at`
      ).then((result) => result.rows).catch(() => []);
      throw new Error(
        `real QA harness failed\n--- stdout ---\n${detail.stdout ?? ''}` +
          `\n--- stderr ---\n${detail.stderr ?? ''}` +
          `\n--- sanitized recovery state ---\n${JSON.stringify(recovery)}`,
        { cause: error },
      );
    });
    expect(stderr).toBe('');
    expect(stdout).toContain('PASS 15 aliases and four harness kinds over real WS');
    expect(stdout).not.toContain('SKIP ');
    expect(stdout).not.toContain('FAIL ');
    const report = JSON.parse(await readFile('ops/artifacts/real/report.json', 'utf8')) as {
      tests: AdapterScenario[];
      evidenceClass?: string;
      executionTarget?: Record<string, unknown>;
      databaseImage?: DatabaseImageBinding;
    };
    expect(report.tests.find((test) => test.evidenceClass === 'adapter-process-roundtrip')?.receipt).toBeDefined();
    const relays = await database.pool.query<{
      request_id: string; message_id: string; delivery_id: string; trace_id: string;
      payload: { correlation: Record<string, string>; outcome: string; result: { output: { reply: string } } };
    }>(`SELECT request_id,message_id,delivery_id,trace_id,payload FROM adapter_outbox
        WHERE kind='origin_relay' AND payload->'correlation'->>'root_message_id' IN (
          SELECT id::text FROM messages WHERE body->>'text' LIKE 'CAUCE_ADAPTER_ROUNDTRIP_V1:%'
        )`);
    expect(relays.rows).toHaveLength(1);
    const relay = relays.rows[0];
    if (!relay) throw new Error('observed adapter relay is missing');
    const root = await database.pool.query<{ nonce: string; epoch: string }>(
      `SELECT substring(m.body->>'text' FROM '^CAUCE_ADAPTER_ROUNDTRIP_V1:([a-f0-9]{32})$') AS nonce,
              d.consumer_epoch::text AS epoch FROM messages m JOIN messages branch ON branch.trace_id=m.trace_id
           JOIN deliveries d ON d.message_id=branch.id
             AND d.recipient_tenant='Steven' AND d.recipient_alias='qa-reviewer-b'
        WHERE m.id=$1 AND d.status='done'`, [relay.payload.correlation.root_message_id],
    );
    expect(root.rows).toHaveLength(1);
    const observed = root.rows[0];
    if (!observed) throw new Error('observed fake2 delivery is missing');
    expect(observed.nonce).toMatch(/^[a-f0-9]{32}$/u);
    const descriptors = Object.fromEntries(await Promise.all(['opencode', 'fake', 'fake2'].map(async (harness): Promise<[string, string]> => [
      harness, createHash('sha256').update(await readFile(`packages/adapter-sdk/descriptors/${harness}.json`)).digest('hex'),
    ])));
    const verifyReport = (candidate: typeof report): void => {
      const scenarios = candidate.tests.filter((test) =>
        test.name === 'OpenCode adapter process fan-out, duplicate publish, and tenant isolation');
      expect(scenarios).toHaveLength(1);
      const scenario = scenarios[0];
      if (!scenario?.receipt) throw new Error('adapter roundtrip receipt is missing');
      expect(scenario).toMatchObject({ status: 'passed', evidence: 'real',
        evidenceClass: 'adapter-process-roundtrip', controlledHarnessExecutables: true });
      const receipt = scenario.receipt;
      expect(scenario.adapterExecutables).toEqual(Object.keys(receipt.adapters));
      expect(receipt.adapters).toEqual({ opencode: 1, fake: 3, fake2: 1 });
      expect(receipt.identities.map(({ tenant, room, alias, harness }) => ({ tenant, room, alias, harness })))
        .toEqual([
          { tenant: 'Steven', room: 'grp.steven', alias: 'qa-opencode', harness: 'opencode' },
          { tenant: 'Steven', room: 'grp.steven', alias: 'qa-reviewer-a', harness: 'fake' },
          { tenant: 'Steven', room: 'grp.steven', alias: 'qa-reviewer-b', harness: 'fake2' },
          { tenant: 'Isa', room: 'grp.isa', alias: 'qa-isolated-source', harness: 'fake' },
          { tenant: 'Jhon', room: 'grp.jhon', alias: 'qa-isolated-target', harness: 'fake' },
        ]);
      for (const identity of receipt.identities) {
        expect(Number.isSafeInteger(identity.leaseEpoch)).toBe(true);
        expect(identity.leaseEpoch).toBeGreaterThan(0);
        expect(identity.descriptorSha256).toBe(descriptors[identity.harness]);
      }
      expect(receipt.identities.find((identity) => identity.harness === 'fake2')?.leaseEpoch).toBe(Number(observed.epoch));
      expect(relay.payload.outcome).toBe('done');
      expect(relay.payload.correlation).toEqual({ request_id: relay.request_id, message_id: relay.message_id,
        delivery_id: relay.delivery_id, trace_id: relay.trace_id, root_message_id: relay.payload.correlation.root_message_id });
      expect(relay.payload.result.output.reply).toBe(`CAUCE_ADAPTER_ROUNDTRIP_FINAL:${observed.nonce}\n\n`
        + '[2 locally synthesized branch replies; 2 branch responses in this chain; 0 without local synthesis]');
      expect(receipt.correlation).toEqual(relay.payload.correlation);
      expect(receipt.correlation.message_id).not.toBe(receipt.correlation.root_message_id);
      expect(receipt.nonceSha256).toBe(createHash('sha256').update(observed.nonce).digest('hex'));
      expect(receipt).toMatchObject({ evidenceClass: 'adapter-process-roundtrip',
        fanoutBranches: 2, concurrentBarrier: true, duplicateSuppressed: true, mutatedDuplicateRejected: true,
        crossTenantIsolation: 'online target excluded and undelivered', finalOriginRelaysForRoundTrip: 1 });
      expect(receipt.cleanup).toEqual({ processGroupsStopped: true, temporaryRootRemoved: true });
      if (process.env.CAUCE_EVIDENCE_CLASS === 'testcontainers') {
        expect(candidate.evidenceClass).toBe('testcontainers-source-execution');
        expect(candidate.databaseImage).toEqual(databaseImageBinding);
        expect(candidate.executionTarget).toEqual({ application: 'source-tree',
          database: 'immutable-testcontainer-image', finalCauceImageExecuted: false });
      }
    };
    verifyReport(report);
    const withoutReceipt = structuredClone(report);
    const alteredIdentity = structuredClone(report);
    for (const scenario of withoutReceipt.tests) {
      if (scenario.evidenceClass === 'adapter-process-roundtrip') delete scenario.receipt;
    }
    for (const scenario of alteredIdentity.tests) {
      const fake2 = scenario.receipt?.identities.find((identity) => identity.harness === 'fake2');
      if (fake2) fake2.harness = 'fake';
    }
    expect(() => verifyReport(withoutReceipt)).toThrow('adapter roundtrip receipt is missing');
    expect(() => verifyReport(alteredIdentity)).toThrow();
  }, 180_000);

  it('runs two permanent-style fake adapters through async push and terminal ACK', async () => {
    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([
      ['Isa', 'salva', 'codex'],
      ['Jhon', 'hegel', 'openclaw'],
    ]);
    const root = await mkdtemp(join(tmpdir(), '.adapter-e2e-'));
    const adapters: ChildProcess[] = [];
    const diagnostics: string[] = [];
    // The room is the agent's OWN identity, not the sender's: these are the rooms seeded by
    // 001_initial.sql for salva/hegel and the ones declared in their fleet manifests. Since
    // 547eda3 the adapter fails closed without it, so this harness must pass it the same way
    // the systemd unit (generate-units.py) and the container supervisor do.
    const identities = [
      { tenant: 'Isa', room: 'grp.isa', alias: 'salva', instance: 'e2e-fake-isa' },
      { tenant: 'Jhon', room: 'grp.jhon', alias: 'hegel', instance: 'e2e-fake-jhon' },
    ];
    try {
      for (const item of identities) {
        const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/fake.js'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CAUCE_TENANT: item.tenant,
            CAUCE_ROOM: item.room,
            CAUCE_ALIAS: item.alias,
            CAUCE_INSTANCE_ID: item.instance,
            CAUCE_STATE_DIR: join(root, item.alias),
            CAUCE_RELAY_URL: `${httpUrl.replace('http:', 'ws:')}/v3/ws`,
            CAUCE_ENVIRONMENT: 'test',
            CAUCE_DEV_AUTH: '1',
            CAUCE_HARNESS_COMMAND: join(process.cwd(), 'packages/adapter-sdk/dist/src/bin/fake-harness.js'),
            CAUCE_HEARTBEAT_MS: '100',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        child.stderr.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        adapters.push(child);
      }
      try {
        await waitFor(async () => {
          const status = await authenticatedFetch<{ presence: Record<string, unknown>[] }>('/v3/status');
          return identities.every((item) => status.presence.some((row) =>
            row.tenant_id === item.tenant && row.alias === item.alias && row.online === true));
        });
      } catch (error) {
        throw new Error(
          `fake adapter presence timed out; child exits=${adapters.map((child) => child.exitCode).join(',')}; diagnostics=${diagnostics.join('|')}`,
          { cause: error },
        );
      }

      for (const item of identities) {
        const published = await authenticatedFetch<{ message_id: string }>('/v3/messages', {
          method: 'POST',
          body: JSON.stringify({
            room_id: 'grp.steven',
            recipients: [{ tenant_id: item.tenant, alias: item.alias }],
            body: { text: `fake adapter ${item.alias}` },
            idempotency_key: `adapter-e2e-${item.alias}`,
            lane: 'interactive',
            priority: 10,
          }),
        });
        let latestState = 'unknown';
        try {
          await waitFor(async () => {
            const message = await authenticatedFetch<{ deliveries: { status: string }[] }>(`/v3/messages/${published.message_id}`);
            latestState = message.deliveries[0]?.status ?? 'missing';
            if (latestState === 'failed' || latestState === 'dead') throw new Error(`fake adapter ${item.alias} ended ${latestState}`);
            return latestState === 'done';
          });
        } catch (error) {
          throw new Error(`fake adapter ${item.alias} stalled at ${latestState}; child exits=${adapters.map((child) => child.exitCode).join(',')}; diagnostics=${diagnostics.join('|')}`, { cause: error });
        }
      }
    } finally {
      await Promise.all(adapters.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves offline deliveries across authentic gateway and PostgreSQL restarts', async () => {
    const startedAt = new Date().toISOString();
    const results: RestartResult[] = [];

    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([['Miguel', 'kratos', 'codex']]);
    const gatewayMessage = await publishForRestart('Miguel', 'kratos', 'grp.steven');
    await restartGateway();
    await consumeAfterRestart('Miguel', 'kratos', gatewayMessage);
    results.push({ name: 'gateway restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([['Pablo', 'seneca', 'openclaw']]);
    const postgresMessage = await publishForRestart('Pablo', 'seneca', 'grp.steven');
    await database.container.restart({ timeout: 30_000 });
    await reconnectDatabaseAfterContainerRestart();
    await consumeAfterRestart('Pablo', 'seneca', postgresMessage);
    results.push({ name: 'PostgreSQL restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await writeRestartArtifacts(results, startedAt);
  }, 120_000);
});

type DeliveryConsumerIdentity =
  | readonly ['Isa', 'salva', 'codex']
  | readonly ['Jhon', 'hegel', 'openclaw']
  | readonly ['Miguel', 'kratos', 'codex']
  | readonly ['Pablo', 'seneca', 'openclaw'];

/**
 * `resetTestDatabase()` truncates the mutable agent registry, and lease admission fails closed
 * without a durable concurrency declaration, so every consumer used after a reset MUST be restored.
 * The placement stays local to this disposable database on purpose: production placement has its
 * own manifest parity gates, and copying it here would be a second source of truth.
 */
async function declareDeliveryConsumers(identities: readonly DeliveryConsumerIdentity[]): Promise<void> {
  for (const [tenant, alias, harness] of identities) await declareConsumer(tenant, alias, harness);
}

async function declareConsumer(tenant: string, alias: string, harness: string): Promise<void> {
  {
    await database.pool.query(
      `INSERT INTO agents(
         tenant_id,alias,harness_id,display_name,enabled,
         container_name,runtime_user,home_directory,state_directory,max_concurrent_deliveries
       ) VALUES ($1,$2,$3,initcap($2),true,$4,'test','/tmp',$5,2)
       ON CONFLICT (tenant_id,alias) DO UPDATE SET
         harness_id=EXCLUDED.harness_id,display_name=EXCLUDED.display_name,enabled=true,
         container_name=EXCLUDED.container_name,runtime_user=EXCLUDED.runtime_user,
         home_directory=EXCLUDED.home_directory,state_directory=EXCLUDED.state_directory,
         max_concurrent_deliveries=EXCLUDED.max_concurrent_deliveries,updated_at=now()`,
      [tenant, alias, harness, `e2e-${alias}`, `/tmp/cauce-v3-e2e/${alias}`],
    );
  }
}

/* Migrations leave no `agents` row, no membership for four aliases and no Miguel edge: without
   this every scenario died on a frame timeout and Steven->Miguel answered 422. */
async function declareHarnessFleet(): Promise<void> {
  const { topology } = await import('../../ops/harness/fleet.mjs');
  for (const [tenant, { room, aliases }] of Object.entries(topology)) {
    for (const alias of aliases) {
      await declareConsumer(tenant, alias, 'fake');
      await database.pool.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
         VALUES($1,$2,$3,'agent',true) ON CONFLICT DO NOTHING`,
        [tenant, room, alias],
      );
    }
  }
  for (const [tenant, room, alias, harness] of [
    ['Steven', 'grp.steven', 'qa-opencode', 'opencode'],
    ['Steven', 'grp.steven', 'qa-reviewer-a', 'fake'],
    ['Steven', 'grp.steven', 'qa-reviewer-b', 'fake2'],
    ['Isa', 'grp.isa', 'qa-isolated-source', 'fake'],
    ['Jhon', 'grp.jhon', 'qa-isolated-target', 'fake'],
  ] as const) {
    await declareConsumer(tenant, alias, harness);
    await database.pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
       VALUES($1,$2,$3,'agent',true) ON CONFLICT DO NOTHING`,
      [tenant, room, alias],
    );
  }
  for (const [from, to] of [['Steven', 'Miguel'], ['Miguel', 'Steven']]) {
    await database.pool.query(
      `INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
       VALUES($1,$2,true,true,true,false) ON CONFLICT DO NOTHING`,
      [from, to],
    );
  }
}

async function restartGateway(): Promise<void> {
  await app.close();
  app = await buildGateway({
    pool: database.pool,
    authProvider: DevOnlyAuthProvider.forTests(),
    leaseTtlMs: 30_000,
    outboxPollMs: 10,
    allowedJobKinds: ['system.database.probe', 'qa.fairness'],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${String(address.port)}`;
}

async function reconnectDatabaseAfterContainerRestart(): Promise<void> {
  const containerHost = database.container.getHost();
  let target = containerHost;
  if (containerHost !== 'external') {
    const endpoint = new URL(database.url);
    const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
    endpoint.hostname = network ? database.container.getIpAddress(network) : containerHost;
    endpoint.port = String(network ? 5432 : database.container.getMappedPort(5432));
    database.url = endpoint.toString();
    database.pool.options.connectionString = database.url;
    target = `${endpoint.hostname}:${endpoint.port}`;
  }

  let lastError: unknown;
  await waitFor(async () => database.pool.query('SELECT 1').then(() => true).catch((error: unknown) => {
    lastError = error;
    return false;
  }), 45_000).catch((error: unknown) => {
    throw new Error(
      `database pool did not reconnect to ${target}`,
      { cause: lastError ?? error },
    );
  });
}

async function publishForRestart(tenant: 'Miguel' | 'Pablo', alias: string, room: string): Promise<string> {
  const response = await authenticatedFetch<{ message_id: string }>('/v3/messages', {
    method: 'POST',
    body: JSON.stringify({
      room_id: room,
      recipients: [{ tenant_id: tenant, alias }],
      body: { text: `restart-${tenant}-${alias}` },
      idempotency_key: randomUUID(),
      lane: 'interactive',
      priority: 10,
    }),
  });
  return response.message_id;
}

async function consumeAfterRestart(tenant: 'Miguel' | 'Pablo', alias: string, messageId: string): Promise<void> {
  const consumer = new FakeHarness({ tenant_id: tenant, alias, instance_id: randomUUID(), capabilities: ['restart-qa'] });
  try {
    await consumer.connect(`${httpUrl.replace('http:', 'ws:')}/v3/ws`);
    const delivery = await consumer.nextDelivery(15_000);
    expect(delivery.message_id).toBe(messageId);
    consumer.ack(delivery, 'done');
    await expect(consumer.waitFor((frame) => frame.type === 'ack_result' && frame.delivery_id === delivery.delivery_id))
      .resolves.toMatchObject({ status: 'done', applied: true });
  } finally {
    await consumer.close();
  }
}

interface RestartResult {
  name: string;
  status: 'passed' | 'skipped';
  evidence: 'real' | 'skipped';
  error?: string;
}

async function writeRestartArtifacts(results: RestartResult[], startedAt: string): Promise<void> {
  const directory = join(process.cwd(), 'ops/artifacts/restarts');
  await mkdir(directory, { recursive: true });
  const report = `${JSON.stringify({
    schemaVersion: 2,
    suite: 'cauce-v3-restart-e2e',
    mode: 'real',
    ...testcontainersBindings(),
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: {
      tests: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: 0,
      skipped: results.filter((result) => result.status === 'skipped').length,
      criticalSkipped: 0,
      real: results.filter((result) => result.evidence === 'real').length,
      mocked: 0,
    },
    tests: results,
  }, null, 2)}\n`;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-restart-e2e" tests="${String(results.length)}" failures="0" skipped="${String(skipped)}">\n${results.map((result) => `  <testcase classname="cauce.restart" name="${result.name}">${result.status === 'skipped' ? `<skipped message="${result.error ?? ''}"/>` : ''}</testcase>`).join('\n')}\n</testsuite>\n`;
  await writeFile(join(directory, 'report.json'), report);
  await writeFile(join(directory, 'junit.xml'), junit);
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${digest(report)}  report.json\n${digest(junit)}  junit.xml\n`);
}

async function authenticatedFetch<T = Record<string, unknown>>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-cauce-tenant', 'Steven');
  headers.set('x-cauce-alias', 'kant');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${httpUrl}${pathname}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`${pathname} returned ${String(response.status)}`);
  return response.json() as Promise<T>;
}

async function waitFor(operation: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition timed out after ${String(timeoutMs)}ms`);
}

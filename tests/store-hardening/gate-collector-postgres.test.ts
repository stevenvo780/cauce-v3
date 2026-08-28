import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../helpers/postgres.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const collector = join(repository, 'ops/scripts/gate-collector.mjs');
const migrationGate = join(repository, 'ops/scripts/migration-gate.mjs');
let database: TestDatabase;
let pool: DatabasePool;
let temporary: string;
let inventory: string;

interface CollectorResult { status: number | null; stdout: string; stderr: string; output: string }
type CollectorChild = ChildProcessByStdio<null, Readable, Readable>;

function startCollector(
  phase: string,
  extra: Record<string, string> = {},
): { child: CollectorChild; done: Promise<CollectorResult> } {
  const output = join(temporary, `snapshot-${randomUUID()}.json`);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CAUCE_DATABASE_URL: database.url,
    CAUCE_GATE_INVENTORY_FILE: inventory,
    CAUCE_GATE_POLLER_FRESH_MS: '120000',
    CAUCE_GATE_REJECTED_ACK_WINDOW_MS: '30000',
    CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS: '1000',
    ...extra,
  };
  delete environment.CAUCE_ROUNDTRIP_MARKER;
  const child = spawn('node', [collector, 'kant', output, phase], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const done = new Promise<CollectorResult>((resolveResult) => {
    child.once('close', (status) => { resolveResult({ status, stdout, stderr, output }); });
  });
  return { child, done };
}

async function collect(phase: string, extra: Record<string, string> = {}) {
  const result = await startCollector(phase, extra).done;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(result.output, 'utf8')) as {
    capturedAt: string;
    v3: { consumers: number; pollers: number; leaseOwners: number };
    acks: { rejectedRecent: number; staleAccepted: number };
    roundTrip: {
      status: string; completedAt: string | null; terminalAckApplied: boolean; activeLeaseMatch: boolean;
    };
  };
}

async function seedLease({ fresh = true }: { fresh?: boolean } = {}) {
  await pool.query(
    `WITH stamp AS (SELECT clock_timestamp() AS value)
     INSERT INTO connection_leases(
       tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at
     ) SELECT 'Steven','kant','systemd-container-kant',1,'["heartbeat"]'::jsonb,
              value+interval '10 minutes',value,value-$1::int*interval '1 millisecond'
         FROM stamp`,
    [fresh ? 1_000 : 0],
  );
}

async function seedTerminalDelivery({ applied = true, ackAgeSeconds = 0 } = {}) {
  const nonce = randomUUID().replaceAll('-', '');
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(
       request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority,auth_session_id,auth_channel
     ) VALUES (
       gen_random_uuid(),$1,'Steven','grp.steven','kant',$2::jsonb,
       'interactive',-100,'gate-probe','gate'
     ) RETURNING id`,
    [`gate-${randomUUID()}`, JSON.stringify({ type: 'system.gate.probe', nonce, timeout_ms: 5_000 })],
  );
  const messageId = message.rows[0]?.id;
  if (!messageId) throw new Error('Expected message row');
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(
       message_id,recipient_tenant,recipient_alias,status,attempt,consumer_instance_id,consumer_epoch,
       claim_token,ack_deadline_at,last_ack_rank,result,terminal_at
     ) VALUES (
       $1,'Steven','kant','done',1,'systemd-container-kant',1,
       gen_random_uuid(),now()+interval '1 minute',3,
       '{"output":{"status":"done","retryable":false}}'::jsonb,now()
     ) RETURNING id`,
    [messageId],
  );
  const deliveryId = delivery.rows[0]?.id;
  if (!deliveryId) throw new Error('Expected delivery row');
  await pool.query(
    `INSERT INTO delivery_acks(
       delivery_id,status,instance_id,epoch,applied,payload,claim_token,attempt,event_id,created_at
     ) SELECT id,'done','systemd-container-kant',1,$2,'{}'::jsonb,claim_token,1,gen_random_uuid(),
              now()-$3::int*interval '1 second'
         FROM deliveries WHERE id=$1`,
    [deliveryId, applied, ackAgeSeconds],
  );
  return { deliveryId, nonce, startedAt };
}

async function evidenceFile(value: Awaited<ReturnType<typeof seedTerminalDelivery>>) {
  const file = join(temporary, `evidence-${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    tenant: 'Steven',
    alias: 'kant',
    deliveryId: value.deliveryId,
    nonce: value.nonce,
    startedAt: value.startedAt,
  })}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

async function waitUntilCollectorBlocks(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE application_name='cauce-gate-collector' AND datname=current_database()
        ORDER BY backend_start DESC LIMIT 1`,
    );
    if (state.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('collector did not reach the deterministic table-lock barrier');
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  temporary = await mkdtemp(join(tmpdir(), 'cauce-gate-collector-postgres-'));
  inventory = join(temporary, 'inventory.json');
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    aliases: { kant: { tenant: 'Steven', room: 'grp.steven' } },
  })}\n`);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE outbox_dead_letters CASCADE');
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
  await pool.end();
  await database.container.stop();
});

describe('gate collector against PostgreSQL', () => {
  it('counts a healthy idle consumer as a poller and rejects an initial/stale heartbeat', async () => {
    await seedLease();
    let snapshot = await collect('preflight');
    expect(snapshot.v3).toEqual({ consumers: 1, pollers: 1, leaseOwners: 1 });

    await pool.query(`UPDATE connection_leases SET last_heartbeat_at=connected_at WHERE tenant_id='Steven' AND alias='kant'`);
    snapshot = await collect('preflight');
    expect(snapshot.v3).toEqual({ consumers: 1, pollers: 0, leaseOwners: 1 });
  });

  it('does not reinterpret historical rejected ACK evidence as permanently pending', async () => {
    await seedLease();
    const terminal = await seedTerminalDelivery({ applied: false, ackAgeSeconds: 120 });
    let snapshot = await collect('preflight');
    expect(snapshot.acks.rejectedRecent).toBe(0);

    await pool.query(
      `INSERT INTO delivery_acks(
         delivery_id,status,instance_id,epoch,applied,payload,claim_token,attempt,event_id
       ) SELECT id,'done','systemd-container-kant',1,false,'{}'::jsonb,claim_token,1,gen_random_uuid()
           FROM deliveries WHERE id=$1`,
      [terminal.deliveryId],
    );
    snapshot = await collect('preflight');
    expect(snapshot.acks.rejectedRecent).toBe(1);
  });

  it('proves a terminal ACK against the same still-live lease and fails on epoch drift', async () => {
    await seedLease();
    const baselineResult = await startCollector('preflight').done;
    expect(baselineResult.status, baselineResult.stderr).toBe(0);
    const terminal = await seedTerminalDelivery();
    const evidence = await evidenceFile(terminal);
    const snapshotResult = await startCollector('post-cutover', {
      CAUCE_GATE_BASELINE_FILE: baselineResult.output,
      CAUCE_GATE_PROBE_EVIDENCE_FILE: evidence,
    }).done;
    expect(snapshotResult.status, snapshotResult.stderr).toBe(0);
    const snapshot = JSON.parse(await readFile(snapshotResult.output, 'utf8')) as {
      roundTrip: { status: string; terminalAckApplied: boolean; activeLeaseMatch: boolean };
    };
    expect(snapshot.roundTrip).toMatchObject({
      status: 'passed', terminalAckApplied: true, activeLeaseMatch: true,
    });
    const gate = spawnSync('node', [migrationGate, 'post-cutover', snapshotResult.output, 'kant'], {
      encoding: 'utf8',
    });
    expect(gate.status, gate.stderr).toBe(0);

    await pool.query(`UPDATE deliveries SET consumer_epoch=2 WHERE id=$1`, [terminal.deliveryId]);
    const drift = await collect('post-cutover', {
      CAUCE_GATE_BASELINE_FILE: baselineResult.output,
      CAUCE_GATE_PROBE_EVIDENCE_FILE: evidence,
    });
    expect(drift.roundTrip).toEqual({
      status: 'failed', completedAt: null, terminalAckApplied: false, activeLeaseMatch: false,
    });
  });

  it('keeps all counters on one repeatable-read snapshot across a concurrent lease expiry', async () => {
    await seedLease();
    const blocker = await pool.connect();
    let child: CollectorChild | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE deliveries IN ACCESS EXCLUSIVE MODE');
      const running = startCollector('preflight');
      child = running.child;
      await waitUntilCollectorBlocks();

      await pool.query(
        `UPDATE connection_leases SET lease_until=now()-interval '1 second'
          WHERE tenant_id='Steven' AND alias='kant'`,
      );
      await blocker.query('COMMIT');
      const result = await running.done;
      expect(result.status, result.stderr).toBe(0);
      const snapshot = JSON.parse(await readFile(result.output, 'utf8')) as {
        v3: { consumers: number; pollers: number; leaseOwners: number };
      };
      expect(snapshot.v3).toEqual({ consumers: 1, pollers: 1, leaseOwners: 1 });
      const live = await pool.query<{ active: boolean }>(
        `SELECT lease_until>now() AS active FROM connection_leases
          WHERE tenant_id='Steven' AND alias='kant'`,
      );
      expect(live.rows[0]?.active).toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      if (child?.exitCode === null) child.kill('SIGKILL');
    }
  });
});

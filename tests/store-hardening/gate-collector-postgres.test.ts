import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { SYSTEM_PRINCIPAL_ALIASES } from '@cauce/protocol';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../helpers/postgres.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const collector = join(repository, 'ops/scripts/gate-collector.mjs');
const migrationGate = join(repository, 'ops/scripts/migration-gate.mjs');
let database: TestDatabase;
let databaseStarted = false;
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
    CAUCE_GATE_SOURCE_ROOM: 'empresa.ámbito',
    CAUCE_GATE_POLLER_FRESH_MS: '120000',
    CAUCE_GATE_REJECTED_ACK_WINDOW_MS: '30000',
    CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS: '1000',
    ...extra,
  };
  delete environment.CAUCE_ROUNDTRIP_MARKER;
  if (!Object.hasOwn(extra, 'CAUCE_INSTALLATION_ID')) delete environment.CAUCE_INSTALLATION_ID;
  const child = spawn('node', [collector, 'operador_principal', output, phase], {
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
    v2: { consumers: number; pollers: number; leaseOwners: number };
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
     ) SELECT 'EmpresaNueva','operador_principal','systemd-container-operador_principal',1,'["heartbeat"]'::jsonb,
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
       gen_random_uuid(),$1,'EmpresaNueva','empresa.ámbito','director_empresa',$2::jsonb,
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
       $1,'EmpresaNueva','operador_principal','done',1,'systemd-container-operador_principal',1,
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
     ) SELECT id,'done','systemd-container-operador_principal',1,$2,'{}'::jsonb,claim_token,1,gen_random_uuid(),
              now()-$3::int*interval '1 second'
         FROM deliveries WHERE id=$1`,
    [deliveryId, applied, ackAgeSeconds],
  );
  return { deliveryId, nonce, startedAt };
}

async function evidenceFile(value: Awaited<ReturnType<typeof seedTerminalDelivery>>, tenant = 'EmpresaNueva') {
  const file = join(temporary, `evidence-${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    tenant,
    alias: 'operador_principal',
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

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  temporary = await mkdtemp(join(tmpdir(), 'cauce-gate-collector-postgres-'));
  inventory = join(temporary, 'inventory.json');
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    fleet: { operador_principal: { tenant: 'EmpresaNueva', room: 'empresa.ámbito' } },
  })}\n`);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE outbox_dead_letters CASCADE');
  await writeFile(inventory, JSON.stringify({ fleet: { operador_principal: { tenant: 'EmpresaNueva', room: 'empresa.ámbito' } } }));
  await pool.query(`INSERT INTO tenants(id) VALUES ('EmpresaNueva'),('EmpresaOtra')`);
  await pool.query(`INSERT INTO rooms(id,tenant_id) VALUES ('empresa.ámbito','EmpresaNueva'),('empresa.otra','EmpresaOtra')`);
  for (const tenant of ['EmpresaNueva', 'EmpresaOtra']) {
    const room = tenant === 'EmpresaNueva' ? 'empresa.ámbito' : 'empresa.otra';
    for (const alias of ['director_empresa', 'operador_principal', ...SYSTEM_PRINCIPAL_ALIASES]) {
      await pool.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES ($1,$2,$3,'operator')`,
        [tenant, room, alias],
      );
      await pool.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
         VALUES ($1,$2,'codex',true,'company-runtime','dev','/home/dev','/var/lib/cauce')`,
        [tenant, alias],
      );
    }
  }
});

afterAll(async () => {
  if (!databaseStarted) return;
  await rm(temporary, { recursive: true, force: true });
  await pool.end();
  await database.container.stop();
});

describe('gate collector against PostgreSQL', () => {
  it('counts a healthy idle consumer as a poller and rejects an initial/stale heartbeat', async () => {
    await seedLease();
    let snapshot = await collect('preflight');
    expect(snapshot.v3).toEqual({ consumers: 1, pollers: 1, leaseOwners: 1 });

    await pool.query(`UPDATE connection_leases SET last_heartbeat_at=connected_at WHERE tenant_id='EmpresaNueva' AND alias='operador_principal'`);
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
       ) SELECT id,'done','systemd-container-operador_principal',1,false,'{}'::jsonb,claim_token,1,gen_random_uuid()
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
    const gate = spawnSync('node', [migrationGate, 'post-cutover', snapshotResult.output, 'operador_principal'], {
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

  async function proofFixture() {
    await seedLease();
    const baseline = await startCollector('preflight').done;
    expect(baseline.status, baseline.stderr).toBe(0);
    const terminal = await seedTerminalDelivery();
    const evidence = await evidenceFile(terminal);
    return {
      terminal,
      settings: { CAUCE_GATE_BASELINE_FILE: baseline.output, CAUCE_GATE_PROBE_EVIDENCE_FILE: evidence },
    };
  }

  async function setProofInstance(deliveryId: string, instance: string) {
    await pool.query(
      `UPDATE connection_leases SET instance_id=$1 WHERE tenant_id='EmpresaNueva' AND alias='operador_principal'`, [instance],
    );
    await pool.query(`UPDATE deliveries SET consumer_instance_id=$2 WHERE id=$1`, [deliveryId, instance]);
    await pool.query(`UPDATE delivery_acks SET instance_id=$2 WHERE delivery_id=$1`, [deliveryId, instance]);
  }

  it('proves both producer lease identifiers in its own installation namespace', async () => {
    const value = await proofFixture();
    for (const instance of ['systemd-empresa-a-operador_principal', 'systemd-container-empresa-a-operador_principal']) {
      await setProofInstance(value.terminal.deliveryId, instance);
      const snapshot = await collect('post-cutover', { ...value.settings, CAUCE_INSTALLATION_ID: 'empresa-a' });
      expect(snapshot.v3).toEqual({ consumers: 1, pollers: 1, leaseOwners: 1 });
      expect(snapshot.v2).toEqual({ consumers: 0, pollers: 0, leaseOwners: 0 });
      expect(snapshot.roundTrip.status).toBe('passed');
    }
  });

  it('does not credit a terminal ACK belonging to another installation namespace', async () => {
    const value = await proofFixture();
    await setProofInstance(value.terminal.deliveryId, 'systemd-container-empresa-a-operador_principal');
    const snapshot = await collect('post-cutover', { ...value.settings, CAUCE_INSTALLATION_ID: 'empresa-b' });
    expect(snapshot.v3).toEqual({ consumers: 0, pollers: 0, leaseOwners: 0 });
    expect(snapshot.v2).toEqual({ consumers: 1, pollers: 1, leaseOwners: 1 });
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  const revokedAuthority: Record<string, string> = {
    agent: `UPDATE agents SET enabled=false WHERE tenant_id='EmpresaNueva' AND alias='director_empresa'`,
    membership: `UPDATE memberships SET enabled=false WHERE tenant_id='EmpresaNueva' AND alias='director_empresa'`,
    tenant: `UPDATE tenants SET enabled=false WHERE id='EmpresaNueva'`,
    room: `UPDATE rooms SET enabled=false WHERE tenant_id='EmpresaNueva' AND id='empresa.ámbito'`,
    role: `UPDATE role_policies SET allow_route=false WHERE role='operator'`,
  };
  it.each(Object.keys(revokedAuthority))('rejects proof after current %s authorization is revoked', async (kind) => {
    const value = await proofFixture();
    const mutation = revokedAuthority[kind];
    if (mutation === undefined) throw new Error('Expected authority mutation');
    await pool.query(mutation);
    const snapshot = await collect('post-cutover', value.settings);
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  it.each([...SYSTEM_PRINCIPAL_ALIASES])('rejects reserved principal %s despite its enabled routable registry', async (principal) => {
    const value = await proofFixture();
    await pool.query(`UPDATE messages SET actor_alias=$2 WHERE id=(SELECT message_id FROM deliveries WHERE id=$1)`, [value.terminal.deliveryId, principal]);
    const snapshot = await collect('post-cutover', value.settings);
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  const invalidMessage: Record<string, string> = {
    session: `auth_session_id='other-session'`,
    channel: `auth_channel='adapter'`,
    origin: `origin='{"channel":"external"}'::jsonb`,
    body: `body=body || '{"extra":true}'::jsonb`,
    nonce: `body=jsonb_set(body,'{nonce}','"ffffffffffffffffffffffffffffffff"'::jsonb)`,
    timeoutString: `body=jsonb_set(body,'{timeout_ms}','"5000"'::jsonb)`,
    timeoutFraction: `body=jsonb_set(body,'{timeout_ms}','1.5'::jsonb)`,
    timeoutZero: `body=jsonb_set(body,'{timeout_ms}','0'::jsonb)`,
    timeoutExcess: `body=jsonb_set(body,'{timeout_ms}','604800001'::jsonb)`,
    lane: `lane='batch'`,
    priority: `priority=0`,
  };
  it.each(Object.keys(invalidMessage))('rejects spoofed message %s without accepting its terminal ACK', async (kind) => {
    const value = await proofFixture();
    const mutation = invalidMessage[kind];
    if (mutation === undefined) throw new Error('Expected message mutation');
    await pool.query(`UPDATE messages SET ${mutation} WHERE id=(SELECT message_id FROM deliveries WHERE id=$1)`, [value.terminal.deliveryId]);
    const snapshot = await collect('post-cutover', value.settings);
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  it.each(['claim_token', 'attempt', 'epoch'])('rejects terminal ACK with mismatched %s', async (field) => {
    const value = await proofFixture();
    const mutation = field === 'claim_token' ? 'claim_token=gen_random_uuid()' : `${field}=2`;
    await pool.query(`UPDATE delivery_acks SET ${mutation} WHERE delivery_id=$1`, [value.terminal.deliveryId]);
    const snapshot = await collect('post-cutover', value.settings);
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  it('rejects another tenant with the same recipient alias and rejects another configured room', async () => {
    const value = await proofFixture();
    let snapshot = await collect('post-cutover', { ...value.settings, CAUCE_GATE_SOURCE_ROOM: 'empresa.otra' });
    expect(snapshot.roundTrip.status).toBe('failed');
    const foreign = await pool.query<{ id: string }>(
      `WITH message AS (
         INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority,auth_session_id,auth_channel)
         SELECT gen_random_uuid(),'foreign-gate','EmpresaOtra','empresa.otra','director_empresa',
                m.body,m.lane,m.priority,m.auth_session_id,m.auth_channel
           FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1
         RETURNING id
       )
       INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,consumer_instance_id,consumer_epoch,
                              claim_token,ack_deadline_at,last_ack_rank,result,terminal_at)
       SELECT message.id,'EmpresaOtra',d.recipient_alias,d.status,d.attempt,d.consumer_instance_id,d.consumer_epoch,
              gen_random_uuid(),d.ack_deadline_at,d.last_ack_rank,d.result,now()
         FROM message,deliveries d WHERE d.id=$1 RETURNING id`,
      [value.terminal.deliveryId],
    );
    const foreignId = foreign.rows[0]?.id;
    if (foreignId === undefined) throw new Error('Expected foreign delivery');
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,payload,claim_token,attempt,event_id)
       SELECT id,'done',consumer_instance_id,consumer_epoch,true,'{}'::jsonb,claim_token,attempt,gen_random_uuid()
         FROM deliveries WHERE id=$1`, [foreignId],
    );
    await pool.query(
      `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at)
       SELECT 'EmpresaOtra',alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at
         FROM connection_leases WHERE tenant_id='EmpresaNueva'`,
    );
    const foreignTerminal = { ...value.terminal, deliveryId: foreignId };
    const foreignEvidence = await evidenceFile(foreignTerminal, 'EmpresaOtra');
    const ownInventory = await readFile(inventory);
    try {
      await writeFile(inventory, JSON.stringify({ fleet: { operador_principal: { tenant: 'EmpresaOtra', room: 'empresa.otra' } } }));
      const baseline = await startCollector('preflight').done;
      expect(baseline.status, baseline.stderr).toBe(0);
      const local = await collect('post-cutover', {
        CAUCE_GATE_BASELINE_FILE: baseline.output, CAUCE_GATE_PROBE_EVIDENCE_FILE: foreignEvidence,
        CAUCE_GATE_SOURCE_ROOM: 'empresa.otra',
      });
      expect(local.roundTrip.status).toBe('passed');
    } finally {
      await writeFile(inventory, ownInventory);
    }
    const wrongScopeEvidence = await evidenceFile(foreignTerminal);
    snapshot = await collect('post-cutover', {
      ...value.settings, CAUCE_GATE_PROBE_EVIDENCE_FILE: wrongScopeEvidence, CAUCE_GATE_SOURCE_ROOM: 'empresa.otra',
    });
    expect(snapshot.roundTrip.status).toBe('failed');
  });

  it('rejects absent, controlled or excessive source room before connecting or writing output', async () => {
    const value = await proofFixture();
    for (const room of ['', 'empresa\n', 'a'.repeat(129)]) {
      const result = await startCollector('post-cutover', { ...value.settings, CAUCE_GATE_SOURCE_ROOM: room }).done;
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('CAUCE_GATE_SOURCE_ROOM is required');
      expect(await readFile(result.output, 'utf8').catch(() => undefined)).toBeUndefined();
    }
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
          WHERE tenant_id='EmpresaNueva' AND alias='operador_principal'`,
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
          WHERE tenant_id='EmpresaNueva' AND alias='operador_principal'`,
      );
      expect(live.rows[0]?.active).toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      if (child?.exitCode === null) child.kill('SIGKILL');
    }
  });
});

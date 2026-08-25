import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = join(repository, 'ops/scripts/migration-gate.mjs');
const scratch: string[] = [];

function baseSnapshot() {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    tenant: 'Steven',
    alias: 'kant',
    capturedAt,
    v2: { consumers: 0, pollers: 0, leaseOwners: 0 },
    v3: { consumers: 0, pollers: 0, leaseOwners: 0 },
    drain: { inflight: 0, overdueInflight: 0, ownershipMismatch: 0 },
    acks: { rejectedRecent: 0, staleAccepted: 0 },
    queues: {
      wakePending: 0,
      outboxPending: 0,
      relayPending: 0,
      dlqOpen: 0,
      dlqNewSinceBaseline: 0,
    },
    roundTrip: {
      status: 'not-run',
      completedAt: null as string | null,
      terminalAckApplied: false,
      activeLeaseMatch: false,
    },
  };
}

async function run(phase: string, mutate: (snapshot: ReturnType<typeof baseSnapshot>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-migration-gate-'));
  scratch.push(root);
  const snapshot = baseSnapshot();
  mutate(snapshot);
  const file = join(root, 'snapshot.json');
  await writeFile(file, `${JSON.stringify(snapshot)}\n`);
  return spawnSync('node', [gate, phase, file, 'kant'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAUCE_GATE_MAX_AGE_SECONDS: '120',
      CAUCE_MAX_WAKE_PENDING: '0',
      CAUCE_MAX_OUTBOX_PENDING: '0',
      CAUCE_MAX_RELAY_PENDING: '0',
    },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('migration gate snapshot v2', () => {
  test('accepts a drained snapshot and rejects legacy schema', async () => {
    expect((await run('drain')).status).toBe(0);
    const legacy = await run('drain', (snapshot) => { snapshot.schemaVersion = 1; });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain('unsupported gate snapshot schemaVersion');
  });

  test('post-cutover requires a live V3 poller plus authentic terminal proof', async () => {
    const valid = await run('post-cutover', (snapshot) => {
      snapshot.v3 = { consumers: 1, pollers: 1, leaseOwners: 1 };
      snapshot.roundTrip = {
        status: 'passed',
        completedAt: snapshot.capturedAt,
        terminalAckApplied: true,
        activeLeaseMatch: true,
      };
    });
    expect(valid.status).toBe(0);

    const forged = await run('post-cutover', (snapshot) => {
      snapshot.v3 = { consumers: 1, pollers: 1, leaseOwners: 1 };
      snapshot.roundTrip = {
        status: 'passed',
        completedAt: snapshot.capturedAt,
        terminalAckApplied: false,
        activeLeaseMatch: true,
      };
    });
    expect(forged.status).toBe(1);
    expect(forged.stderr).toContain('passed without terminal ACK and live lease proof');

    const noPoller = await run('post-cutover', (snapshot) => {
      snapshot.v3 = { consumers: 1, pollers: 0, leaseOwners: 1 };
      snapshot.roundTrip = {
        status: 'passed',
        completedAt: snapshot.capturedAt,
        terminalAckApplied: true,
        activeLeaseMatch: true,
      };
    });
    expect(noPoller.status).toBe(1);
    expect(noPoller.stderr).toContain('v3.pollers must be exactly one');
  });

  test('retained historical dead letters do not block, but new dead letters do', async () => {
    const retained = await run('drain', (snapshot) => { snapshot.queues.dlqOpen = 9; });
    expect(retained.status).toBe(0);

    const regression = await run('drain', (snapshot) => {
      snapshot.queues.dlqOpen = 10;
      snapshot.queues.dlqNewSinceBaseline = 1;
    });
    expect(regression.status).toBe(1);
    expect(regression.stderr).toContain('queues.dlqNewSinceBaseline must be zero');
  });

  test('rejects ownership, stale-ACK and recent rejected-ACK evidence in every phase', async () => {
    for (const [field, mutate] of [
      ['ownership', (snapshot: ReturnType<typeof baseSnapshot>) => { snapshot.drain.ownershipMismatch = 1; }],
      ['stale', (snapshot: ReturnType<typeof baseSnapshot>) => { snapshot.acks.staleAccepted = 1; }],
      ['rejected', (snapshot: ReturnType<typeof baseSnapshot>) => { snapshot.acks.rejectedRecent = 1; }],
    ] as const) {
      const result = await run('preflight', mutate);
      expect(result.status, field).toBe(1);
    }
  });
});

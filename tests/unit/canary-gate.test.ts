import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ops = join(repository, 'ops');
const canary = join(ops, 'scripts/canary.sh');
const scratch: string[] = [];

function parseJson(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  return parsed;
}

function ephemeralPath(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected a gate path record');
  }

  const record = value as Record<string, unknown>;
  const path = record.evidence ?? record.snapshot;
  if (typeof path !== 'string') {
    throw new TypeError('expected an evidence or snapshot path');
  }
  return path;
}

function gateSnapshot() {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    tenant: 'Steven',
    alias: 'kant',
    capturedAt,
    v2: { consumers: 0, pollers: 0, leaseOwners: 0 },
    v3: { consumers: 1, pollers: 1, leaseOwners: 1 },
    drain: { inflight: 0, overdueInflight: 0, ownershipMismatch: 0 },
    acks: { rejectedRecent: 0, staleAccepted: 0 },
    queues: {
      wakePending: 0, outboxPending: 0, relayPending: 0, dlqOpen: 4, dlqNewSinceBaseline: 0,
    },
    roundTrip: {
      status: 'passed', completedAt: capturedAt, terminalAckApplied: true, activeLeaseMatch: true,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cauce-canary-'));
  scratch.push(root);
  const snapshots = join(root, 'snapshots');
  await mkdir(snapshots);
  const collector = join(root, 'collector');
  const probe = join(root, 'probe');
  await copyFile(join(ops, 'tests/fake-gate-collector.mjs'), collector);
  await copyFile(join(ops, 'tests/fake-gate-roundtrip-probe.mjs'), probe);
  await Promise.all([collector, probe].map((file) => chmod(file, 0o755)));
  await writeFile(join(snapshots, 'canary.json'), `${JSON.stringify(gateSnapshot())}\n`);
  const baseline = join(root, 'baseline.json');
  await writeFile(baseline, `${JSON.stringify({ ...gateSnapshot(), v3: { consumers: 0, pollers: 0, leaseOwners: 0 } })}\n`);
  return {
    root,
    snapshots,
    collector,
    probe,
    baseline,
    sequence: join(root, 'sequence.log'),
    paths: join(root, 'paths.log'),
  };
}

function run(value: Awaited<ReturnType<typeof fixture>>, extra: Record<string, string> = {}) {
  return spawnSync(canary, ['kant', value.baseline], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: value.root,
      CAUCE_GATE_CAPTURE_PATH: value.collector,
      CAUCE_GATE_PROBE_PATH: value.probe,
      FAKE_GATE_SNAPSHOT_DIR: value.snapshots,
      FAKE_GATE_SEQUENCE_LOG: value.sequence,
      FAKE_GATE_PATH_LOG: value.paths,
      ...extra,
    },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('canary authentic gate orchestration', () => {
  test('runs a fresh probe before a fresh collection and removes ephemeral evidence', async () => {
    const value = await fixture();
    const result = run(value);
    expect(result.status, result.stderr).toBe(0);
    const sequence = (await readFile(value.sequence, 'utf8')).trim().split('\n').map(parseJson);
    expect(sequence).toEqual([{ action: 'probe' }, { action: 'collector', phase: 'canary' }]);
    const paths = (await readFile(value.paths, 'utf8')).trim().split('\n').map(parseJson);
    for (const item of paths) {
      const ephemeral = ephemeralPath(item);
      expect(await lstat(ephemeral).catch(() => undefined)).toBeUndefined();
    }
  });

  test('probe and collector failures are hard failures with no silent fallback', async () => {
    const probeFailure = await fixture();
    let result = run(probeFailure, { FAKE_GATE_PROBE_EXIT: '79' });
    expect(result.status).toBe(79);
    expect((await readFile(probeFailure.sequence, 'utf8')).trim()).toBe('{"action":"probe"}');

    const collectorFailure = await fixture();
    result = run(collectorFailure, { FAKE_GATE_COLLECTOR_EXIT: '80' });
    expect(result.status).toBe(80);
    const sequence = (await readFile(collectorFailure.sequence, 'utf8')).trim().split('\n').map(parseJson);
    expect(sequence).toEqual([{ action: 'probe' }, { action: 'collector', phase: 'canary' }]);
  });

  test('rejects symlinked baselines and non-executable collectors', async () => {
    const value = await fixture();
    const symlink = join(value.root, 'baseline-link.json');
    await import('node:fs/promises').then(({ symlink: createSymlink }) => createSymlink(value.baseline, symlink));
    let result = spawnSync(canary, ['kant', symlink], {
      encoding: 'utf8',
      env: { ...process.env, CAUCE_GATE_CAPTURE_PATH: value.collector, CAUCE_GATE_PROBE_PATH: value.probe },
    });
    expect(result.status).toBe(2);

    await chmod(value.collector, 0o600);
    result = run(value);
    expect(result.status).toBe(2);
  });
});

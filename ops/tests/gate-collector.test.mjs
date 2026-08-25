#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collector = path.join(ops, 'scripts/gate-collector.mjs');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cauce-gate-collector-'));
const inventory = path.join(temporary, 'inventory.json');
const baseline = path.join(temporary, 'baseline.json');
const evidence = path.join(temporary, 'evidence.json');
const output = path.join(temporary, 'snapshot.json');

function run(arguments_, extra = {}) {
  return spawnSync('node', [collector, ...arguments_], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAUCE_DATABASE_URL: 'postgres://127.0.0.1:1/unreachable',
      CAUCE_GATE_INVENTORY_FILE: inventory,
      ...extra,
    },
  });
}

try {
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    aliases: { kant: { tenant: 'Steven', room: 'grp.steven' } },
  })}\n`);
  await writeFile(baseline, `${JSON.stringify({
    schemaVersion: 2, tenant: 'Steven', alias: 'kant', capturedAt: new Date().toISOString(),
  })}\n`);
  await writeFile(evidence, `${JSON.stringify({
    schemaVersion: 1,
    tenant: 'Steven',
    alias: 'kant',
    deliveryId: '00000000-0000-4000-8000-000000000001',
    nonce: '00000000000000000000000000000001',
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  let result = spawnSync('node', [collector], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/);

  result = run(['Invalid-Alias', output, 'drain']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid alias format/);

  result = spawnSync('node', [collector, 'kant', output, 'drain'], {
    encoding: 'utf8', env: { ...process.env, CAUCE_DATABASE_URL: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAUCE_DATABASE_URL is required/);

  result = run(['kant', output, 'drain'], { CAUCE_ROUNDTRIP_MARKER: 'passed' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden/);

  result = run(['kant', output, 'post-cutover']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAUCE_GATE_BASELINE_FILE is required/);

  result = run(['kant', output, 'post-cutover'], { CAUCE_GATE_BASELINE_FILE: baseline });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAUCE_GATE_PROBE_EVIDENCE_FILE is required/);

  const baselineLink = path.join(temporary, 'baseline-link.json');
  await symlink(baseline, baselineLink);
  result = run(['kant', output, 'post-cutover'], { CAUCE_GATE_BASELINE_FILE: baselineLink });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular non-symlink/);

  await chmod(evidence, 0o644);
  result = run(['kant', output, 'post-cutover'], {
    CAUCE_GATE_BASELINE_FILE: baseline,
    CAUCE_GATE_PROBE_EVIDENCE_FILE: evidence,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode 0600/);

  process.stdout.write('gate-collector pre-database validation tests passed\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

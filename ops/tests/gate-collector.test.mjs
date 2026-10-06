#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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

function environment(extra = {}) {
  return {
    ...process.env,
    CAUCE_DATABASE_URL: 'postgres://127.0.0.1:1/unreachable',
    CAUCE_GATE_INVENTORY_FILE: inventory,
    CAUCE_GATE_SOURCE_ROOM: 'grp.steven',
    ...extra,
  };
}

function run(arguments_, extra = {}) {
  return spawnSync('node', [collector, ...arguments_], { encoding: 'utf8', env: environment(extra) });
}

async function observeDatabaseConnection(alias, installation) {
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected loopback observer address');
    const child = spawn('node', [collector, alias, output, 'drain'], {
      env: environment({ CAUCE_DATABASE_URL: `postgres://127.0.0.1:${address.port}/unreachable`, CAUCE_INSTALLATION_ID: installation }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', resolveExit);
    });
    return { status, stderr, connections };
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

try {
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 1,
    fleet: { kant: { tenant: 'Steven', room: 'grp.steven', enabled: true } },
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

  await chmod(evidence, 0o600);
  for (const room of [undefined, '', 'empresa\n', 'empresa\u0085', 'a'.repeat(129)]) {
    result = run(['kant', output, 'post-cutover'], {
      CAUCE_GATE_BASELINE_FILE: baseline,
      CAUCE_GATE_PROBE_EVIDENCE_FILE: evidence,
      CAUCE_GATE_SOURCE_ROOM: room,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CAUCE_GATE_SOURCE_ROOM is required/u);
  }

  for (const installation of ['', 'empresa_principal', '../empresa', 'empresa\n', 'a'.repeat(49), 'A']) {
    result = run(['kant', output, 'drain'], { CAUCE_INSTALLATION_ID: installation });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CAUCE_INSTALLATION_ID must be a canonical installation identifier/u);
  }

  const longestAlias = 'a'.repeat(64);
  await writeFile(inventory, JSON.stringify({ fleet: { [longestAlias]: { tenant: 'EmpresaNueva', room: 'empresa.ámbito' } } }));
  for (const installation of [undefined, 'a'.repeat(45)]) {
    result = await observeDatabaseConnection(longestAlias, installation);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /database snapshot collection failed/u);
    assert.equal(result.connections, 1);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  for (const installation of ['a'.repeat(46), 'a'.repeat(48)]) {
    result = await observeDatabaseConnection(longestAlias, installation);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /consumer instance identifier exceeds protocol limit of 128 characters/u);
    assert.equal(result.connections, 0);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }

  process.stdout.write('gate-collector pre-database validation tests passed\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

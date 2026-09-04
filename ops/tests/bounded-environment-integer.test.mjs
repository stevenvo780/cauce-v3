#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundedInteger } from '../scripts/bounded-environment-integer.mjs';

const variable = 'CAUCE_TEST_BOUNDED_INTEGER';
const previous = process.env[variable];

function setRaw(raw) {
  if (raw === undefined) delete process.env[variable];
  else process.env[variable] = raw;
}

function rejects(raw, minimum = 1, maximum = 10) {
  setRaw(raw);
  assert.throws(
    () => boundedInteger(variable, 5, minimum, maximum),
    new Error(`${variable} must be an integer between ${minimum} and ${maximum}`),
  );
}

try {
  setRaw(undefined);
  assert.equal(boundedInteger(variable, 5, 1, 10), 5);

  setRaw('1');
  assert.equal(boundedInteger(variable, 5, 1, 10), 1);
  setRaw('10');
  assert.equal(boundedInteger(variable, 5, 1, 10), 10);

  rejects('');
  rejects('2.5');
  rejects('NaN');
  rejects('0');
  rejects('11');
} finally {
  setRaw(previous);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ops = path.resolve(here, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cauce-bounded-integer-'));
const inventory = path.join(temporary, 'inventory.json');
const output = path.join(temporary, 'output.json');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('CAUCE_GATE_')),
);

try {
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    aliases: { kant: { tenant: 'Steven', room: 'grp.steven' } },
  })}\n`);

  let result = spawnSync('node', [path.join(ops, 'scripts/gate-collector.mjs'), 'kant', output, 'drain'], {
    encoding: 'utf8',
    env: {
      ...cleanEnvironment,
      CAUCE_DATABASE_URL: 'postgres://127.0.0.1:1/unreachable',
      CAUCE_GATE_INVENTORY_FILE: inventory,
      CAUCE_GATE_POLLER_FRESH_MS: '',
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CAUCE_GATE_POLLER_FRESH_MS must be an integer between 5000 and 120000/u);

  result = spawnSync('node', [path.join(ops, 'scripts/gate-roundtrip-probe.mjs'), 'kant', output], {
    encoding: 'utf8',
    env: {
      ...cleanEnvironment,
      CAUCE_GATE_INVENTORY_FILE: inventory,
      CAUCE_GATE_PROBE_HTTP_TIMEOUT_MS: '1.5',
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CAUCE_GATE_PROBE_HTTP_TIMEOUT_MS must be an integer between 1000 and 60000/u);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('bounded environment integer tests passed\n');

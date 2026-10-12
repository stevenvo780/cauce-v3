#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseContextSeedArguments, summarize } from '../cli/context_seed.mjs';

const cli = fileURLToPath(new URL('../cli/context_seed.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../cli/cauce', import.meta.url));

function run(args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...environment }, timeout: 40_000 });
}

test('shows the seed operation without connecting to a database', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contexto sembrar \[--empresa ID\] \[--nativos DIR\] \[--simular\]/u);
  assert.match(result.stdout, /idempotente/u);
});

test('parses the seed options and resolves the natives directory', () => {
  assert.deepEqual(parseContextSeedArguments(['contexto', 'sembrar']), { company: undefined, natives: undefined, dryRun: false });
  assert.deepEqual(parseContextSeedArguments(['contexto', 'sembrar', '--simular', '--empresa', 'humanizar', '--nativos', '/srv/natives']),
    { company: 'humanizar', natives: '/srv/natives', dryRun: true });
  assert.equal(parseContextSeedArguments(['contexto', 'sembrar', '--nativos', 'natives']).natives, `${process.cwd()}/natives`);
});

test('rejects malformed input before connecting', () => {
  for (const args of [
    ['contexto'], ['contexto', 'borrar'], ['contexto', 'sembrar', '--empresa', 'Bad Id'], ['contexto', 'sembrar', '--empresa'],
    ['contexto', 'sembrar', '--simular', '--simular'], ['contexto', 'sembrar', '--sql', 'DELETE FROM agent_context_versions'],
    ['contexto', 'sembrar', '--nativos', ' /srv'], ['contexto', 'sembrar', 'extra'],
  ]) {
    const result = run(args, { DATABASE_URL: 'postgresql://placeholder@127.0.0.1:1/db' });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /PostgreSQL|ECONN|Siembra interrumpida/u);
  }
  const unconfigured = run(['contexto', 'sembrar']);
  assert.equal(unconfigured.status, 2, unconfigured.stderr);
  assert.match(unconfigured.stderr, /DATABASE_URL_FILE o DATABASE_URL/u);
});

test('reports an unreachable database as an interrupted seed that is safe to repeat', () => {
  const result = run(['contexto', 'sembrar'], { DATABASE_URL: 'postgresql://placeholder@127.0.0.1:1/db' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Siembra interrumpida.*repetirla es seguro/u);
});

test('cauce platform routes contexto to the seed command', () => {
  const result = spawnSync(entry, ['platform', 'contexto', 'sembrar', '--empresa', 'Bad Id'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--empresa no es un id de empresa válido/u);
});

test('counts every seed state', () => {
  assert.deepEqual(summarize([{ state: 'seeded' }, { state: 'existing' }, { state: 'existing' }, { state: 'empty' }]),
    { seeded: 1, planned: 0, existing: 2, empty: 1 });
});

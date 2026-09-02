#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { topology } from '../harness/fleet.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationPath = path.join(repositoryRoot, 'packages/store/migrations/001_initial.sql');
const migration = await readFile(migrationPath, 'utf8');
const where = 'packages/store/migrations/001_initial.sql';

function valuesBlock(table) {
  const block = migration.match(
    new RegExp(`INSERT INTO ${table}\\([^)]*\\) VALUES([\\s\\S]*?)ON CONFLICT`, 'u'),
  );
  assert(block, `no INSERT INTO ${table} ... VALUES block in ${where}`);
  return block[1];
}

function tuples(table, arity) {
  const columns = Array.from({ length: arity }, () => "'([^']*)'").join(',');
  const rows = [...valuesBlock(table).matchAll(new RegExp(`\\(${columns}\\)`, 'gu'))]
    .map((match) => match.slice(1));
  assert(rows.length > 0, `could not parse any ${table} row out of ${where}`);
  return rows;
}

const seededRooms = new Map(tuples('rooms', 2).map(([room, tenant]) => [tenant, room]));
const seededMemberships = new Set(
  tuples('memberships', 4).map(([tenant, room, alias]) => `${tenant}/${room}/${alias}`),
);

for (const [tenant, { room, aliases }] of Object.entries(topology)) {
  assert.equal(seededRooms.get(tenant), room,
    `fixture room ${room} for tenant ${tenant} is not the room seeded in ${where}`);
  for (const alias of aliases) {
    assert(seededMemberships.has(`${tenant}/${room}/${alias}`),
      `fixture triple (${tenant}, ${room}, ${alias}) has no membership seeded in ${where}; `
      + 'the qa:real database only knows the aliases that migration inserts');
  }
}

process.stdout.write('harness fleet seed tests passed\n');

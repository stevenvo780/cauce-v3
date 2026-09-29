#!/usr/bin/env node
// Test-only fleet seed for ops/compose.test.yaml. Inserts the harness
// topology (ops/harness/fleet.mjs) as enabled agents so WS hello leases
// succeed. Never runs against production: the test stack owns its database.
import pg from 'pg';
import { topology } from './fleet.mjs';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('seed-test-fleet.mjs requires DATABASE_URL');
  process.exit(2);
}

const rows = [];
for (const [tenant, value] of Object.entries(topology)) {
  for (const alias of value.aliases) {
    rows.push([tenant, alias]);
  }
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const values = rows
    .map(([, alias], index) => {
      const base = index * 2;
      return `($${base + 1}, $${base + 2}, 'fake', true, 'qa-${alias}', 'qa', '/tmp/qa-${alias}', '/tmp/qa-${alias}/state')`;
    })
    .join(', ');
  const result = await client.query(
    `INSERT INTO agents
       (tenant_id, alias, harness_id, enabled, container_name, runtime_user, home_directory, state_directory)
     VALUES ${values}
     ON CONFLICT (tenant_id, alias) DO NOTHING`,
    rows.flat(),
  );
  console.log(`seed-test-fleet: ${result.rowCount} agents inserted (${rows.length} topology aliases)`);
} finally {
  await client.end();
}

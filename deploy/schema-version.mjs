#!/usr/bin/env node

import { createPool } from '../packages/store/dist/db.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
await assertProductionPostgresTls();
const pool = createPool(connectionString, { max: 1, applicationName: 'cauce-schema-version' });
try {
  const result = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const version = result.rows[0]?.version;
  if (typeof version !== 'string' || !/^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(version)) {
    throw new Error('database has no valid current migration version');
  }
  process.stdout.write(`${version}\n`);
} finally {
  await pool.end();
}

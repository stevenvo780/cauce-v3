#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createPool } from '../packages/store/dist/db.js';
import { inspectMigrationIntegrity } from '../packages/store/dist/migration-integrity.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const phase = process.argv[2] ?? 'pre';
if (!['pre', 'post'].includes(phase) || process.argv.length > 3) {
  throw new Error('usage: migration-integrity.mjs [pre|post]');
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

await assertProductionPostgresTls();
const pool = createPool(connectionString, { max: 1, applicationName: 'cauce-migration-integrity' });
try {
  const client = await pool.connect();
  try {
    const integrity = await inspectMigrationIntegrity(client);
    const legacy = integrity.entries.find((entry) => entry.version === '024_agent_role_templates.sql');
    if (!legacy?.applied || !legacy.observedSchemaSha256) {
      throw new Error('024 structural equivalence is required before dependent migrations');
    }
    if (phase === 'post') {
      const pending = integrity.entries.filter((entry) => !entry.applied);
      if (pending.length > 0) throw new Error('post-migration evidence contains pending migrations');
      const unledgered = integrity.entries.filter(
        (entry) => entry.version >= '026_agent_profile.sql' && entry.sourceOrigin !== 'applied-atomically',
      );
      if (unledgered.length > 0) throw new Error('post-migration evidence contains unledgered migrations');
    }
    const migrationSetSha256 = createHash('sha256')
      .update(integrity.entries.map((entry) => `${entry.version}\0${entry.sourceSha256}\n`).join(''))
      .digest('hex');
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      suite: 'cauce-v3-migration-integrity',
      phase,
      generatedAt: new Date().toISOString(),
      sourceOriginPolicy: 'never-infer-from-version-name',
      migrationSetSha256,
      structuralContract: integrity.structuralContract,
      entries: integrity.entries,
    })}\n`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

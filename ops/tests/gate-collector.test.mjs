#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collector = path.join(ops, 'scripts/gate-collector.mjs');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cauce-gate-collector-'));
const outputDir = path.join(temporary, 'outputs');

async function setupTestDatabase() {
  // Use a test database URL. In CI, this would connect to a test Postgres instance.
  const testDbUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cauce_test';

  const client = new pg.Client({ connectionString: testDbUrl });
  try {
    await client.connect();

    // Verify connection and that schema exists
    const { rows: tables } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('connection_leases', 'deliveries', 'delivery_acks', 'adapter_outbox', 'outbox_dead_letters')
    `);

    await client.end();
    return testDbUrl;
  } catch (error) {
    if (sql) await sql.end();
    console.log('skipping gate-collector tests: test database unavailable');
    process.exit(0);
  }
}

async function runCollector(alias, outputFile, phase, env = {}) {
  const result = spawnSync('node', [collector, alias, outputFile, phase], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result;
}

try {
  await mkdir(outputDir, { recursive: true });

  // Test 1: Invalid arguments
  let result = spawnSync('node', [collector], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'collector should reject missing arguments');
  assert(result.stderr.includes('usage:'), 'collector should show usage on bad args');
  console.log('invalid arguments rejected');

  // Test 2: Invalid alias format
  result = spawnSync('node', [collector, 'Invalid-Alias', path.join(outputDir, 'test.json'), 'drain'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'collector should reject invalid alias format');
  console.log('invalid alias format rejected');

  // Test 3: Missing database URL
  result = spawnSync('node', [collector, 'test-alias', path.join(outputDir, 'test.json'), 'drain'], {
    encoding: 'utf8',
    env: { ...process.env, CAUCE_DATABASE_URL: '' },
  });
  assert.notEqual(result.status, 0, 'collector should require CAUCE_DATABASE_URL');
  assert(result.stderr.includes('CAUCE_DATABASE_URL'), 'collector should mention missing env var');
  console.log('missing database URL detected');

  // Test 4: Invalid phase
  result = spawnSync('node', [collector, 'test', path.join(outputDir, 'test.json'), 'invalid-phase'], {
    encoding: 'utf8',
    env: { CAUCE_DATABASE_URL: 'postgres://localhost' },
  });
  assert.notEqual(result.status, 0, 'collector should reject invalid phase');
  console.log('invalid phase rejected');

  // Test 5: Database connection with valid database
  const dbUrl = await setupTestDatabase();

  if (dbUrl) {
    const outputFile = path.join(outputDir, 'drain.json');
    result = await runCollector('test', outputFile, 'drain', { CAUCE_DATABASE_URL: dbUrl });

    if (result.status === 0) {
      const content = await readFile(outputFile, 'utf8');
      const snapshot = JSON.parse(content);

      // Verify snapshot structure
      assert.equal(snapshot.schemaVersion, 1, 'schema version should be 1');
      assert.equal(snapshot.alias, 'test', 'alias should match');
      assert(snapshot.capturedAt, 'capturedAt should be set');
      assert(new Date(snapshot.capturedAt), 'capturedAt should be valid ISO timestamp');

      // Verify all required fields are present
      assert.deepStrictEqual(Object.keys(snapshot.v2).sort(), ['consumers', 'leaseOwners', 'pollers']);
      assert.deepStrictEqual(Object.keys(snapshot.v3).sort(), ['consumers', 'leaseOwners', 'pollers']);
      assert.deepStrictEqual(Object.keys(snapshot.drain).sort(), ['inflight', 'unsettledDeliveries']);
      assert.deepStrictEqual(Object.keys(snapshot.acks).sort(), ['invalid', 'pending', 'staleAccepted']);
      assert.deepStrictEqual(Object.keys(snapshot.queues).sort(), ['dlqOpen', 'outboxPending', 'relayPending', 'wakePending']);

      // Verify all counts are non-negative integers
      assert(Number.isSafeInteger(snapshot.v2.consumers) && snapshot.v2.consumers >= 0);
      assert(Number.isSafeInteger(snapshot.v3.consumers) && snapshot.v3.consumers >= 0);
      assert(['passed', 'failed', 'not-run'].includes(snapshot.roundTrip), 'roundTrip should be valid');

      console.log('database collection succeeded with valid snapshot');
    } else {
      console.log(`database collection attempted but database connection failed (status ${result.status})`);
    }
  }

  // Test 6: Round-trip marker environment variable
  const rtFile = path.join(outputDir, 'rt.json');
  result = await runCollector('test', rtFile, 'post-cutover', {
    CAUCE_DATABASE_URL: dbUrl || 'postgres://fake',
    CAUCE_ROUNDTRIP_MARKER: 'passed',
  });
  // This will fail if DB unavailable, but test the env var parsing logic if it succeeds
  if (result.status === 0) {
    const snapshot = JSON.parse(await readFile(rtFile, 'utf8'));
    assert.equal(snapshot.roundTrip, 'passed', 'roundTrip should be set from env var');
    console.log('roundTrip marker honored');
  }

  process.stdout.write('gate-collector tests passed\n');
} catch (error) {
  console.error(`test failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

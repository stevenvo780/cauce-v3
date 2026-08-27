#!/usr/bin/env node

import { createPool } from '../packages/store/dist/db.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';
import {
  applyLegacyConsoleOutboxReconciliation,
  inspectLegacyConsoleOutbox,
  legacyConsoleOutboxReason,
} from './reconcile-stale-console-outbox-core.mjs';

const phase = process.argv[2] ?? 'inspect';
if (!['inspect', 'pre', 'apply', 'post'].includes(phase) || process.argv.length > 3) {
  throw new Error('usage: reconcile-stale-console-outbox.mjs inspect|pre|apply|post');
}
const thresholdSeconds = Number(process.env.CAUCE_OUTBOX_RECONCILE_STALE_SECONDS ?? '86400');
if (!Number.isSafeInteger(thresholdSeconds) || thresholdSeconds < 3_600) {
  throw new Error('CAUCE_OUTBOX_RECONCILE_STALE_SECONDS must be an integer of at least 3600');
}
if (phase === 'apply'
    && process.env.CAUCE_OUTBOX_RECONCILE_CONFIRM !== `dead-letter:${legacyConsoleOutboxReason}`) {
  throw new Error('exact CAUCE_OUTBOX_RECONCILE_CONFIRM is required');
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
await assertProductionPostgresTls();
const pool = createPool(connectionString, { max: 2, applicationName: 'cauce-outbox-reconcile' });
try {
  const generatedAt = new Date().toISOString();
  const application = phase === 'apply'
    ? await applyLegacyConsoleOutboxReconciliation(pool, { thresholdSeconds, expectedCandidates: 1 })
    : null;
  const inspection = await inspectLegacyConsoleOutbox(pool, {
    thresholdSeconds,
    baselineAt: process.env.CAUCE_OUTBOX_BASELINE_AT ?? null,
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    suite: 'cauce-v3-legacy-console-outbox-reconciliation',
    phase,
    generatedAt,
    ...inspection,
    ...(application === null ? {} : { application }),
  })}\n`);
} finally {
  await pool.end();
}

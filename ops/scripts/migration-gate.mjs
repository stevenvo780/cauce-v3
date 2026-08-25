#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [phase, snapshotPath, expectedAlias] = process.argv.slice(2);
const phases = new Set([
  'preflight', 'drain', 'post-cutover', 'canary',
  'rollback-drain', 'rollback-ready', 'watchdog', 'reconciler',
]);
if (!phases.has(phase) || !snapshotPath || !expectedAlias || process.argv.length !== 5) {
  console.error('usage: migration-gate.mjs PHASE SNAPSHOT.json ALIAS');
  process.exit(2);
}

function fail(message) { throw new Error(message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) fail(`${name} has unexpected or missing fields`);
}
function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  return value;
}
function consumer(value, name) {
  object(value, name);
  exactKeys(value, ['consumers', 'pollers', 'leaseOwners'], name);
  return {
    consumers: count(value.consumers, `${name}.consumers`),
    pollers: count(value.pollers, `${name}.pollers`),
    leaseOwners: count(value.leaseOwners, `${name}.leaseOwners`),
  };
}
function zero(value, name) { if (value !== 0) fail(`${name} must be zero`); }
function one(value, name) { if (value !== 1) fail(`${name} must be exactly one`); }
function threshold(name, fallback = 0) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  return value;
}
function timestamp(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(`${name} must be an RFC3339 timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${name} must be an RFC3339 timestamp`);
  return parsed;
}

try {
  const parsed = JSON.parse(await readFile(snapshotPath, 'utf8'));
  object(parsed, 'snapshot');
  exactKeys(parsed, [
    'schemaVersion', 'tenant', 'alias', 'capturedAt', 'v2', 'v3',
    'drain', 'acks', 'queues', 'roundTrip',
  ], 'snapshot');
  if (parsed.schemaVersion !== 2) fail('unsupported gate snapshot schemaVersion');
  if (typeof parsed.tenant !== 'string' || parsed.tenant.length < 1 || parsed.tenant.length > 64) {
    fail('snapshot tenant is invalid');
  }
  if (parsed.alias !== expectedAlias || !/^[a-z][a-z0-9-]*$/.test(parsed.alias)) {
    fail('snapshot alias mismatch');
  }
  const captured = timestamp(parsed.capturedAt, 'capturedAt');
  const ageMs = Date.now() - captured;
  const maxAgeMs = threshold('CAUCE_GATE_MAX_AGE_SECONDS', 120) * 1_000;
  if (ageMs < -5_000 || ageMs > maxAgeMs) fail('gate snapshot is stale or from the future');

  const v2 = consumer(parsed.v2, 'v2');
  const v3 = consumer(parsed.v3, 'v3');
  object(parsed.drain, 'drain');
  exactKeys(parsed.drain, ['inflight', 'overdueInflight', 'ownershipMismatch'], 'drain');
  object(parsed.acks, 'acks');
  exactKeys(parsed.acks, ['rejectedRecent', 'staleAccepted'], 'acks');
  object(parsed.queues, 'queues');
  exactKeys(parsed.queues, [
    'wakePending', 'outboxPending', 'relayPending', 'dlqOpen', 'dlqNewSinceBaseline',
  ], 'queues');
  for (const [name, value] of Object.entries(parsed.drain)) count(value, `drain.${name}`);
  for (const [name, value] of Object.entries(parsed.acks)) count(value, `acks.${name}`);
  for (const [name, value] of Object.entries(parsed.queues)) count(value, `queues.${name}`);

  object(parsed.roundTrip, 'roundTrip');
  exactKeys(parsed.roundTrip, [
    'status', 'completedAt', 'terminalAckApplied', 'activeLeaseMatch',
  ], 'roundTrip');
  if (!['passed', 'failed', 'not-run'].includes(parsed.roundTrip.status)) {
    fail('roundTrip.status is invalid');
  }
  if (typeof parsed.roundTrip.terminalAckApplied !== 'boolean' ||
      typeof parsed.roundTrip.activeLeaseMatch !== 'boolean') {
    fail('roundTrip proof flags must be boolean');
  }
  const completedAt = timestamp(parsed.roundTrip.completedAt, 'roundTrip.completedAt', true);
  if (completedAt !== null && (completedAt > captured + 5_000 || completedAt < captured - 30 * 60_000)) {
    fail('roundTrip.completedAt is outside the bounded capture window');
  }
  if (parsed.roundTrip.status === 'passed') {
    if (completedAt === null || !parsed.roundTrip.terminalAckApplied || !parsed.roundTrip.activeLeaseMatch) {
      fail('roundTrip passed without terminal ACK and live lease proof');
    }
  } else if (parsed.roundTrip.terminalAckApplied || parsed.roundTrip.activeLeaseMatch) {
    fail('roundTrip proof flags require passed status');
  }

  for (const [name, side] of [['v2', v2], ['v3', v3]]) {
    if (side.consumers > 1 || side.pollers > 1 || side.leaseOwners > 1) {
      fail(`${name} has duplicate consumers, pollers, or lease owners`);
    }
    if (side.pollers > side.consumers) fail(`${name} poller has no consumer`);
    if (side.leaseOwners > side.consumers) fail(`${name} lease owner has no consumer`);
  }
  if ((v2.consumers > 0 && v3.consumers > 0) || (v2.pollers > 0 && v3.pollers > 0)) {
    fail('V2 and V3 consumers/pollers overlap');
  }

  zero(parsed.drain.overdueInflight, 'drain.overdueInflight');
  zero(parsed.drain.ownershipMismatch, 'drain.ownershipMismatch');
  zero(parsed.acks.rejectedRecent, 'acks.rejectedRecent');
  zero(parsed.acks.staleAccepted, 'acks.staleAccepted');
  zero(parsed.queues.dlqNewSinceBaseline, 'queues.dlqNewSinceBaseline');

  if (phase === 'drain') {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    zero(v3.consumers, 'v3.consumers'); zero(v3.pollers, 'v3.pollers'); zero(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight');
  }
  if (['post-cutover', 'canary', 'watchdog', 'reconciler'].includes(phase)) {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    one(v3.consumers, 'v3.consumers'); one(v3.pollers, 'v3.pollers'); one(v3.leaseOwners, 'v3.leaseOwners');
    if (parsed.queues.wakePending > threshold('CAUCE_MAX_WAKE_PENDING')) fail('wake backlog exceeds gate');
    if (parsed.queues.outboxPending > threshold('CAUCE_MAX_OUTBOX_PENDING')) fail('outbox backlog exceeds gate');
    if (parsed.queues.relayPending > threshold('CAUCE_MAX_RELAY_PENDING')) fail('relay backlog exceeds gate');
  }
  if (['post-cutover', 'canary'].includes(phase) && parsed.roundTrip.status !== 'passed') {
    fail('authentic round-trip evidence is required');
  }
  if (phase === 'rollback-drain') {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    one(v3.consumers, 'v3.consumers'); one(v3.pollers, 'v3.pollers'); one(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight');
  }
  if (phase === 'rollback-ready') {
    zero(v3.consumers, 'v3.consumers'); zero(v3.pollers, 'v3.pollers'); zero(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight');
  }
  console.log(`gate ${phase} passed for ${expectedAlias}`);
} catch (error) {
  console.error(`gate ${phase} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}

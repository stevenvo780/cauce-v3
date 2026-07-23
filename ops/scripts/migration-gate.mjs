#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [phase, snapshotPath, expectedAlias] = process.argv.slice(2);
const phases = new Set(['preflight', 'drain', 'post-cutover', 'canary', 'rollback-drain', 'rollback-ready', 'watchdog', 'reconciler']);
if (!phases.has(phase) || !snapshotPath || !expectedAlias) {
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
  object(value, name); exactKeys(value, ['consumers', 'pollers', 'leaseOwners'], name);
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

try {
  const parsed = JSON.parse(await readFile(snapshotPath, 'utf8'));
  object(parsed, 'snapshot');
  exactKeys(parsed, ['schemaVersion', 'alias', 'capturedAt', 'v2', 'v3', 'drain', 'acks', 'queues', 'roundTrip'], 'snapshot');
  if (parsed.schemaVersion !== 1) fail('unsupported gate snapshot schemaVersion');
  if (parsed.alias !== expectedAlias || !/^[a-z][a-z0-9-]*$/.test(parsed.alias)) fail('snapshot alias mismatch');
  const captured = Date.parse(parsed.capturedAt);
  if (!Number.isFinite(captured)) fail('capturedAt must be an RFC3339 timestamp');
  const ageMs = Date.now() - captured;
  const maxAgeMs = threshold('CAUCE_GATE_MAX_AGE_SECONDS', 120) * 1000;
  if (ageMs < -5000 || ageMs > maxAgeMs) fail('gate snapshot is stale or from the future');
  const v2 = consumer(parsed.v2, 'v2');
  const v3 = consumer(parsed.v3, 'v3');
  object(parsed.drain, 'drain'); exactKeys(parsed.drain, ['inflight', 'unsettledDeliveries'], 'drain');
  object(parsed.acks, 'acks'); exactKeys(parsed.acks, ['pending', 'invalid', 'staleAccepted'], 'acks');
  object(parsed.queues, 'queues'); exactKeys(parsed.queues, ['wakePending', 'outboxPending', 'relayPending', 'dlqOpen'], 'queues');
  for (const [name, value] of Object.entries(parsed.drain)) count(value, `drain.${name}`);
  for (const [name, value] of Object.entries(parsed.acks)) count(value, `acks.${name}`);
  for (const [name, value] of Object.entries(parsed.queues)) count(value, `queues.${name}`);
  if (!['passed', 'failed', 'not-run'].includes(parsed.roundTrip)) fail('roundTrip is invalid');
  for (const [name, side] of [['v2', v2], ['v3', v3]]) {
    if (side.consumers > 1 || side.pollers > 1 || side.leaseOwners > 1) fail(`${name} has duplicate consumers, pollers, or lease owners`);
    if (side.leaseOwners > side.consumers) fail(`${name} lease owner has no consumer`);
  }
  if ((v2.consumers > 0 && v3.consumers > 0) || (v2.pollers > 0 && v3.pollers > 0)) {
    fail('V2 and V3 consumers/pollers overlap');
  }
  zero(parsed.acks.invalid, 'acks.invalid');
  zero(parsed.acks.staleAccepted, 'acks.staleAccepted');
  zero(parsed.queues.dlqOpen, 'queues.dlqOpen');

  if (phase === 'drain') {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    zero(v3.consumers, 'v3.consumers'); zero(v3.pollers, 'v3.pollers'); zero(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight'); zero(parsed.drain.unsettledDeliveries, 'drain.unsettledDeliveries'); zero(parsed.acks.pending, 'acks.pending');
  }
  if (['post-cutover', 'canary', 'watchdog', 'reconciler'].includes(phase)) {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    one(v3.consumers, 'v3.consumers'); one(v3.pollers, 'v3.pollers'); one(v3.leaseOwners, 'v3.leaseOwners');
    if (parsed.queues.wakePending > threshold('CAUCE_MAX_WAKE_PENDING')) fail('wake backlog exceeds gate');
    if (parsed.queues.outboxPending > threshold('CAUCE_MAX_OUTBOX_PENDING')) fail('outbox backlog exceeds gate');
    if (parsed.queues.relayPending > threshold('CAUCE_MAX_RELAY_PENDING')) fail('relay backlog exceeds gate');
  }
  if (['post-cutover', 'canary'].includes(phase)) {
    zero(parsed.acks.pending, 'acks.pending');
    if (parsed.roundTrip !== 'passed') fail('authentic round-trip evidence is required');
  }
  if (phase === 'rollback-drain') {
    zero(v2.consumers, 'v2.consumers'); zero(v2.pollers, 'v2.pollers'); zero(v2.leaseOwners, 'v2.leaseOwners');
    one(v3.consumers, 'v3.consumers'); one(v3.pollers, 'v3.pollers'); one(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight'); zero(parsed.drain.unsettledDeliveries, 'drain.unsettledDeliveries'); zero(parsed.acks.pending, 'acks.pending');
  }
  if (phase === 'rollback-ready') {
    zero(v3.consumers, 'v3.consumers'); zero(v3.pollers, 'v3.pollers'); zero(v3.leaseOwners, 'v3.leaseOwners');
    zero(parsed.drain.inflight, 'drain.inflight'); zero(parsed.drain.unsettledDeliveries, 'drain.unsettledDeliveries'); zero(parsed.acks.pending, 'acks.pending');
  }
  console.log(`gate ${phase} passed for ${expectedAlias}`);
} catch (error) {
  console.error(`gate ${phase} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}

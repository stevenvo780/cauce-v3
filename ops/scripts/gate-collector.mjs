#!/usr/bin/env node
/**
 * Read-only and coherent capture of Cauce V3 cutover gates.
 *
 * A round-trip is not credited by an environment variable. For post-cutover/canary, an mTLS probe
 * publishes a delivery and leaves ephemeral 0600 evidence; this collector verifies in PostgreSQL
 * that THIS delivery ended with ACK applied by the same lease/epoch that is still alive.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  lstat, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_PRINCIPAL_ALIASES } from '@cauce/protocol';
import { boundedInteger } from './bounded-environment-integer.mjs';

const requireFromStore = createRequire(new URL('../../packages/store/package.json', import.meta.url));
const { Client } = requireFromStore('pg');

const [alias, outputFile, phase] = process.argv.slice(2);
const phases = new Set([
  'preflight', 'drain', 'post-cutover', 'canary',
  'rollback-drain', 'rollback-ready', 'watchdog', 'reconciler',
]);
const roundTripPhases = new Set(['post-cutover', 'canary']);
const baselinePhases = new Set(['post-cutover', 'canary', 'watchdog', 'reconciler']);
const here = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.length !== 5 || !phases.has(phase) || !alias || !outputFile) {
  console.error('usage: gate-collector.mjs ALIAS OUTPUT_FILE PHASE');
  process.exit(2);
}
if (/^[a-z][a-z0-9_-]{0,63}$/.exec(alias)?.[0] !== alias) {
  console.error('invalid alias format');
  process.exit(2);
}
if (process.env.CAUCE_ROUNDTRIP_MARKER !== undefined) {
  console.error('CAUCE_ROUNDTRIP_MARKER is forbidden; use authentic probe evidence');
  process.exit(2);
}
const dbUrl = process.env.CAUCE_DATABASE_URL;
if (!dbUrl) {
  console.error('CAUCE_DATABASE_URL is required');
  process.exit(2);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) throw new Error(`${label} has unexpected or missing fields`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an RFC3339 timestamp`);
  }
  return value;
}

async function regularJsonFile(file, label, { privateFile = false, maxBytes = 1_048_576 } = {}) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute`);
  const metadata = await lstat(file).catch(() => undefined);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  if (privateFile && (metadata.mode & 0o077) !== 0) throw new Error(`${label} must have mode 0600`);
  if (privateFile && typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the collector user`);
  }
  let decoded;
  try {
    decoded = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return decoded;
}

async function targetFromInventory() {
  const configured = process.env.CAUCE_GATE_INVENTORY_FILE;
  const inventoryFile = configured ?? path.resolve(here, '..', 'flota.json');
  const decoded = await regularJsonFile(inventoryFile, 'gate inventory');
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) ||
      !decoded.fleet || typeof decoded.fleet !== 'object' || Array.isArray(decoded.fleet)) {
    throw new Error('gate inventory is invalid');
  }
  const entry = decoded.fleet[alias];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.tenant !== 'string' || entry.tenant.length === 0) {
    throw new Error('alias is not declared in the gate inventory');
  }
  return { tenant: entry.tenant, alias };
}

async function baselineFor(target) {
  const baselineFile = process.env.CAUCE_GATE_BASELINE_FILE;
  if (!baselineFile) {
    if (baselinePhases.has(phase)) throw new Error('CAUCE_GATE_BASELINE_FILE is required for this phase');
    return undefined;
  }
  const decoded = await regularJsonFile(baselineFile, 'gate baseline');
  if (!decoded || decoded.schemaVersion !== 2 || decoded.tenant !== target.tenant || decoded.alias !== target.alias) {
    throw new Error('gate baseline target or schema does not match');
  }
  return { capturedAt: timestamp(decoded.capturedAt, 'gate baseline capturedAt') };
}

async function roundTripEvidenceFor(target) {
  const evidenceFile = process.env.CAUCE_GATE_PROBE_EVIDENCE_FILE;
  if (!roundTripPhases.has(phase)) {
    if (evidenceFile !== undefined) throw new Error('round-trip evidence is not accepted for this phase');
    return undefined;
  }
  if (!evidenceFile) throw new Error('CAUCE_GATE_PROBE_EVIDENCE_FILE is required for this phase');
  const decoded = await regularJsonFile(evidenceFile, 'round-trip evidence', {
    privateFile: true,
    maxBytes: 4_096,
  });
  exactKeys(decoded, [
    'schemaVersion', 'tenant', 'alias', 'deliveryId', 'nonce', 'startedAt',
  ], 'round-trip evidence');
  if (decoded.schemaVersion !== 1 || decoded.tenant !== target.tenant || decoded.alias !== target.alias) {
    throw new Error('round-trip evidence target or schema does not match');
  }
  if (typeof decoded.deliveryId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.deliveryId)) {
    throw new Error('round-trip evidence delivery identifier is invalid');
  }
  if (typeof decoded.nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(decoded.nonce)) {
    throw new Error('round-trip evidence nonce is invalid');
  }
  const startedAt = timestamp(decoded.startedAt, 'round-trip evidence startedAt');
  const age = Date.now() - Date.parse(startedAt);
  if (age < -5_000 || age > 30 * 60_000) throw new Error('round-trip evidence is stale or from the future');
  return { deliveryId: decoded.deliveryId, nonce: decoded.nonce, startedAt };
}

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`database returned invalid ${label}`);
  return parsed;
}

function consumerLeaseIds(alias) {
  const installation = process.env.CAUCE_INSTALLATION_ID;
  if (installation !== undefined && /^[a-z][a-z0-9-]{0,47}$/.exec(installation)?.[0] !== installation) {
    throw new Error('CAUCE_INSTALLATION_ID must be a canonical installation identifier');
  }
  const prefix = installation === undefined ? '' : `${installation}-`;
  const ids = [`systemd-${prefix}${alias}`, `systemd-container-${prefix}${alias}`];
  if (ids.some((id) => id.length > 128)) {
    throw new Error('consumer instance identifier exceeds protocol limit of 128 characters');
  }
  return ids;
}

function gateSourceRoom() {
  const room = process.env.CAUCE_GATE_SOURCE_ROOM;
  if (typeof room !== 'string' || room.length < 1 || room.length > 128 || /\p{Cc}/u.test(room)) {
    throw new Error('CAUCE_GATE_SOURCE_ROOM is required and must contain 1..128 characters without control characters');
  }
  return room;
}

function gateProbeConditions(roomParameter, principalsParameter) {
  return `m.tenant_id=$2 AND m.room_id=${roomParameter}
    AND EXISTS (
      SELECT 1 FROM memberships member
      JOIN tenants tenant ON tenant.id=member.tenant_id
      JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
      JOIN role_policies role ON role.role=member.role
      JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
      WHERE member.tenant_id=m.tenant_id AND member.room_id=m.room_id AND member.alias=m.actor_alias
        AND NOT (member.alias=ANY(${principalsParameter}::text[]))
        AND member.enabled AND tenant.enabled AND room.enabled AND role.allow_route AND agent.enabled
    )
    AND m.auth_session_id='gate-probe' AND m.auth_channel='gate' AND m.origin IS NULL
    AND m.lane='interactive' AND m.priority=-100
    AND m.body->>'type'='system.gate.probe' AND m.body->>'nonce'=$4
    AND (SELECT count(*) FROM jsonb_object_keys(m.body))=3
    AND CASE WHEN jsonb_typeof(m.body->'timeout_ms')='number' THEN
      (m.body->>'timeout_ms')::numeric BETWEEN 1 AND 604800000
      AND (m.body->>'timeout_ms')::numeric=trunc((m.body->>'timeout_ms')::numeric)
    ELSE false END`;
}

async function waitForTerminal(client, target, evidence, timeoutMs, sourceRoom) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT d.status
         FROM deliveries d
         JOIN messages m ON m.id=d.message_id
        WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3
          AND ${gateProbeConditions('$6', '$7')}
          AND m.created_at >= $5::timestamptz`,
      [evidence.deliveryId, target.tenant, target.alias, evidence.nonce, evidence.startedAt, sourceRoom, SYSTEM_PRINCIPAL_ALIASES],
    );
    const status = result.rows[0]?.status;
    if (status === undefined) return;
    if (['done', 'failed', 'dead'].includes(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function atomicWriteJson(destination, value) {
  const absolute = path.resolve(destination);
  const existing = await lstat(absolute).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error('output file must not be a symlink');
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function collectSnapshot() {
  const target = await targetFromInventory();
  const leaseIds = consumerLeaseIds(target.alias);
  const baseline = await baselineFor(target);
  const evidence = await roundTripEvidenceFor(target);
  const sourceRoom = evidence ? gateSourceRoom() : undefined;
  const pollerFreshMs = boundedInteger('CAUCE_GATE_POLLER_FRESH_MS', 30_000, 5_000, 120_000);
  const rejectedAckWindowMs = boundedInteger('CAUCE_GATE_REJECTED_ACK_WINDOW_MS', 300_000, 30_000, 3_600_000);
  const roundTripTimeoutMs = boundedInteger('CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS', 600_000, 1_000, 1_800_000);
  const client = new Client({ connectionString: dbUrl, application_name: 'cauce-gate-collector' });
  let transaction = false;
  try {
    await client.connect();
    if (evidence) await waitForTerminal(client, target, evidence, roundTripTimeoutMs, sourceRoom);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;

    const consumerResult = await client.query(
      `SELECT
         count(*) FILTER (WHERE instance_id<>ALL($4::text[]))::text AS v2_consumers,
         count(*) FILTER (WHERE instance_id<>ALL($4::text[])
           AND capabilities ? 'heartbeat'
           AND last_heartbeat_at > connected_at
           AND last_heartbeat_at >= transaction_timestamp()-$3::int*interval '1 millisecond')::text AS v2_pollers,
         count(*) FILTER (WHERE instance_id=ANY($4::text[]))::text AS v3_consumers,
         count(*) FILTER (WHERE instance_id=ANY($4::text[])
           AND capabilities ? 'heartbeat'
           AND last_heartbeat_at > connected_at
           AND last_heartbeat_at >= transaction_timestamp()-$3::int*interval '1 millisecond')::text AS v3_pollers
       FROM connection_leases
       WHERE tenant_id=$1 AND alias=$2 AND lease_until>transaction_timestamp()`,
      [target.tenant, target.alias, pollerFreshMs, leaseIds],
    );
    const consumerState = consumerResult.rows[0];

    const drainResult = await client.query(
      `SELECT
         count(*)::text AS inflight,
         count(*) FILTER (WHERE ack_deadline_at IS NULL OR ack_deadline_at<=transaction_timestamp())::text AS overdue_inflight,
         count(*) FILTER (WHERE consumer_instance_id IS NULL OR consumer_epoch IS NULL OR NOT EXISTS (
           SELECT 1 FROM connection_leases lease
            WHERE lease.tenant_id=d.recipient_tenant AND lease.alias=d.recipient_alias
              AND lease.instance_id=d.consumer_instance_id AND lease.epoch=d.consumer_epoch
              AND lease.lease_until>transaction_timestamp()
         ))::text AS ownership_mismatch
       FROM deliveries d
       WHERE recipient_tenant=$1 AND recipient_alias=$2
         AND status IN ('leased','accepted','started')`,
      [target.tenant, target.alias],
    );
    const drainState = drainResult.rows[0];

    const ackResult = await client.query(
      `SELECT
         (SELECT count(*)::text FROM delivery_acks ack
           JOIN deliveries d ON d.id=ack.delivery_id
          WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
            AND NOT ack.applied
            AND ack.created_at>=transaction_timestamp()-$3::int*interval '1 millisecond') AS rejected_recent,
         (SELECT count(*)::text FROM deliveries d
          WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
            AND d.status IN ('accepted','started')
            AND (d.ack_deadline_at IS NULL OR d.ack_deadline_at<=transaction_timestamp())) AS stale_accepted`,
      [target.tenant, target.alias, rejectedAckWindowMs],
    );
    const ackState = ackResult.rows[0];

    const queuesResult = await client.query(
      `SELECT
         count(*) FILTER (WHERE outbox.kind='wake' AND outbox.status='pending')::text AS wake_pending,
         count(*) FILTER (WHERE outbox.kind='origin_relay' AND outbox.status='pending')::text AS outbox_pending,
         count(*) FILTER (WHERE outbox.kind='origin_relay' AND outbox.status IN ('pending','failed'))::text AS relay_pending,
         (SELECT count(*)::text FROM outbox_dead_letters dead WHERE dead.resolved_at IS NULL) AS dlq_open,
         (SELECT count(*)::text FROM outbox_dead_letters dead
           WHERE dead.created_at>COALESCE($1::timestamptz,transaction_timestamp())) AS dlq_new_since_baseline,
         transaction_timestamp() AS captured_at
       FROM adapter_outbox outbox`,
      [baseline?.capturedAt ?? null],
    );
    const queuesState = queuesResult.rows[0];

    let roundTrip = {
      status: 'not-run', completedAt: null, terminalAckApplied: false, activeLeaseMatch: false,
    };
    if (evidence) {
      const proofResult = await client.query(
        `SELECT d.status,d.terminal_at,
           (d.status='done'
             AND d.result#>>'{output,status}'='done'
             AND COALESCE(d.result#>>'{output,retryable}','false')='false') AS result_valid,
           EXISTS (
             SELECT 1 FROM delivery_acks ack
              WHERE ack.delivery_id=d.id AND ack.status='done' AND ack.applied
                AND ack.instance_id=d.consumer_instance_id AND ack.epoch=d.consumer_epoch
                AND ack.claim_token=d.claim_token AND ack.attempt=d.attempt
           ) AS terminal_ack_applied,
           EXISTS (
             SELECT 1 FROM connection_leases lease
              WHERE lease.tenant_id=d.recipient_tenant AND lease.alias=d.recipient_alias
                AND lease.instance_id=d.consumer_instance_id AND lease.epoch=d.consumer_epoch
                AND lease.instance_id=ANY($9::text[])
                AND lease.lease_until>transaction_timestamp()
                AND lease.capabilities ? 'heartbeat'
                AND lease.last_heartbeat_at>lease.connected_at
                AND lease.last_heartbeat_at>=transaction_timestamp()-$6::int*interval '1 millisecond'
           ) AS active_lease_match
         FROM deliveries d JOIN messages m ON m.id=d.message_id
        WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3
          AND ${gateProbeConditions('$7', '$8')}
          AND m.created_at >= $5::timestamptz`,
        [
          evidence.deliveryId, target.tenant, target.alias, evidence.nonce,
          evidence.startedAt, pollerFreshMs, sourceRoom, SYSTEM_PRINCIPAL_ALIASES, leaseIds,
        ],
      );
      const proof = proofResult.rows[0];
      const passed = proof?.result_valid === true && proof.terminal_ack_applied === true &&
        proof.active_lease_match === true && proof.terminal_at instanceof Date;
      roundTrip = passed
        ? {
            status: 'passed', completedAt: proof.terminal_at.toISOString(),
            terminalAckApplied: true, activeLeaseMatch: true,
          }
        : {
            status: 'failed', completedAt: null,
            terminalAckApplied: false, activeLeaseMatch: false,
          };
    }

    await client.query('COMMIT');
    transaction = false;
    const snapshot = {
      schemaVersion: 2,
      tenant: target.tenant,
      alias: target.alias,
      capturedAt: queuesState.captured_at.toISOString(),
      v2: {
        consumers: number(consumerState.v2_consumers, 'v2 consumers'),
        pollers: number(consumerState.v2_pollers, 'v2 pollers'),
        leaseOwners: number(consumerState.v2_consumers, 'v2 lease owners'),
      },
      v3: {
        consumers: number(consumerState.v3_consumers, 'v3 consumers'),
        pollers: number(consumerState.v3_pollers, 'v3 pollers'),
        leaseOwners: number(consumerState.v3_consumers, 'v3 lease owners'),
      },
      drain: {
        inflight: number(drainState.inflight, 'inflight'),
        overdueInflight: number(drainState.overdue_inflight, 'overdue inflight'),
        ownershipMismatch: number(drainState.ownership_mismatch, 'ownership mismatch'),
      },
      acks: {
        rejectedRecent: number(ackState.rejected_recent, 'recent rejected ACKs'),
        staleAccepted: number(ackState.stale_accepted, 'stale accepted deliveries'),
      },
      queues: {
        wakePending: number(queuesState.wake_pending, 'wake pending'),
        outboxPending: number(queuesState.outbox_pending, 'outbox pending'),
        relayPending: number(queuesState.relay_pending, 'relay pending'),
        dlqOpen: number(queuesState.dlq_open, 'open DLQ'),
        dlqNewSinceBaseline: number(queuesState.dlq_new_since_baseline, 'new DLQ'),
      },
      roundTrip,
    };
    await atomicWriteJson(outputFile, snapshot);
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && (
      error.message.startsWith('CAUCE_') || error.message.startsWith('gate ') ||
      error.message.startsWith('round-trip ') || error.message.startsWith('alias ') ||
      error.message.startsWith('output ')
    )) throw error;
    // PostgreSQL SQLSTATE is a fixed classifier, never row data, identifiers or message bodies.
    // Keeping it makes a failed release gate diagnosable without leaking the underlying error.
    const sqlState = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` (${error.code})` : '';
    throw new Error(`database snapshot collection failed${sqlState}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

collectSnapshot().catch((error) => {
  console.error(`snapshot collection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 2;
});

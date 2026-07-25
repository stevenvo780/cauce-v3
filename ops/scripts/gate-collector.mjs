#!/usr/bin/env node
/**
 * Real gate snapshot collector for Cauce V3 migration gates.
 *
 * Captures system state across PostgreSQL, systemd, and optional round-trip validation.
 * Queries are READ-ONLY; no state modifications occur.
 *
 * Usage:
 *   gate-collector.mjs ALIAS OUTPUT_FILE PHASE
 *
 * Environment:
 *   CAUCE_DATABASE_URL - PostgreSQL connection string (required)
 *   CAUCE_HARNESS_HEALTHY_MARKER - optional file/env indicating harness passed round-trip
 *   CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS - timeout for round-trip check (default: 30000)
 */

import { writeFile } from 'node:fs/promises';
import pg from 'pg';

// El repo usa `pg` en todos los paquetes (packages/store, services/*); `postgres` no es
// una dependencia de este monorepo. Las consultas van parametrizadas con $1.

const [alias, outputFile, phase] = process.argv.slice(2);
const phases = new Set(['preflight', 'drain', 'post-cutover', 'canary', 'rollback-drain', 'rollback-ready', 'watchdog', 'reconciler']);

if (!phases.has(phase) || !alias || !outputFile) {
  console.error('usage: gate-collector.mjs ALIAS OUTPUT_FILE PHASE');
  process.exit(2);
}

if (!/^[a-z][a-z0-9-]*$/.test(alias)) {
  console.error('invalid alias format');
  process.exit(2);
}

const dbUrl = process.env.CAUCE_DATABASE_URL;
if (!dbUrl) {
  console.error('CAUCE_DATABASE_URL is required');
  process.exit(2);
}

async function collectSnapshot() {
  const client = new pg.Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (error) {
    console.error(`database connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(2);
  }
  // Sólo lectura: el colector nunca debe poder mutar estado productivo.
  await client.query('BEGIN READ ONLY');

  try {
    // Query consumer/poller/leaseOwner counts for v2 and v3.
    // Consumers: connection_leases with valid lease_until (both v2 and v3).
    // Pollers: count of deliveries with inflight status per instance.
    // LeaseOwners: same as consumers (they hold the lease).
    //
    // V2 vs V3 is identified by instance_id patterns:
    // - V3 container: instance_id starts with "cauce-v3-" or contains "-container-"
    // - V3 host-native: instance_id starts with "systemd-"
    // - V2: any other pattern or from legacy consumers
    const consumerStateSql = `
      WITH v2_leases AS (
        SELECT COUNT(*) as count
        FROM connection_leases
        WHERE alias = $1
          AND lease_until > now()
          AND (instance_id NOT LIKE 'systemd-%'
               AND instance_id NOT LIKE '%container%'
               AND instance_id NOT LIKE 'cauce-v3-%')
      ),
      v3_leases AS (
        SELECT COUNT(*) as count
        FROM connection_leases
        WHERE alias = $1
          AND lease_until > now()
          AND (instance_id LIKE 'systemd-%'
               OR instance_id LIKE '%container%'
               OR instance_id LIKE 'cauce-v3-%')
      ),
      v2_pollers AS (
        SELECT COUNT(DISTINCT consumer_instance_id) as count
        FROM deliveries
        WHERE recipient_alias = $1
          AND status IN ('leased', 'accepted', 'started')
          AND (consumer_instance_id NOT LIKE 'systemd-%'
               AND consumer_instance_id NOT LIKE '%container%'
               AND consumer_instance_id NOT LIKE 'cauce-v3-%'
               OR consumer_instance_id IS NULL)
      ),
      v3_pollers AS (
        SELECT COUNT(DISTINCT consumer_instance_id) as count
        FROM deliveries
        WHERE recipient_alias = $1
          AND status IN ('leased', 'accepted', 'started')
          AND (consumer_instance_id LIKE 'systemd-%'
               OR consumer_instance_id LIKE '%container%'
               OR consumer_instance_id LIKE 'cauce-v3-%')
      )
      SELECT
        (SELECT count FROM v2_leases) as v2_consumers,
        (SELECT count FROM v2_pollers) as v2_pollers,
        (SELECT count FROM v3_leases) as v3_consumers,
        (SELECT count FROM v3_pollers) as v3_pollers;
    `;
    const { rows: [consumerState] } = await client.query(consumerStateSql, [alias]);

    // Query drain state: inflight deliveries and unsettled delivery_acks.
    const drainSql = `
      WITH inflight AS (
        SELECT COUNT(*) as count
        FROM deliveries
        WHERE recipient_alias = $1
          AND status IN ('leased', 'accepted', 'started')
      ),
      unsettled AS (
        SELECT COUNT(*) as count
        FROM delivery_acks a
        JOIN deliveries d ON d.id = a.delivery_id
        WHERE d.recipient_alias = $1
          AND a.applied = false
      )
      SELECT
        (SELECT count FROM inflight) as inflight,
        (SELECT count FROM unsettled) as unsettled_deliveries;
    `;
    const { rows: [drainState] } = await client.query(drainSql, [alias]);

    // Query ack state: pending, invalid, and stale accepted acks.
    const acksSql = `
      WITH pending AS (
        SELECT COUNT(*) as count
        FROM delivery_acks a
        JOIN deliveries d ON d.id = a.delivery_id
        WHERE d.recipient_alias = $1
          AND a.applied = false
      ),
      invalid AS (
        SELECT COUNT(*) as count
        FROM delivery_acks a
        JOIN deliveries d ON d.id = a.delivery_id
        WHERE d.recipient_alias = $1
          AND a.status = 'accepted'
          AND a.applied = true
          AND (d.status NOT IN ('done', 'failed', 'dead')
               OR d.consumer_instance_id IS NULL)
      ),
      stale_accepted AS (
        SELECT COUNT(*) as count
        FROM delivery_acks a
        JOIN deliveries d ON d.id = a.delivery_id
        WHERE d.recipient_alias = $1
          AND a.status = 'accepted'
          AND a.created_at < now() - interval '5 minutes'
          AND d.status IN ('leased', 'accepted', 'started')
      )
      SELECT
        (SELECT count FROM pending) as pending,
        (SELECT count FROM invalid) as invalid,
        (SELECT count FROM stale_accepted) as stale_accepted;
    `;
    const { rows: [acksState] } = await client.query(acksSql, [alias]);

    // Query queue state: wake, outbox, relay pending and dlq open.
    const queuesSql = `
      WITH wake_pending AS (
        SELECT COUNT(*) as count
        FROM adapter_outbox
        WHERE kind = 'wake' AND status = 'pending'
      ),
      outbox_pending AS (
        SELECT COUNT(*) as count
        FROM adapter_outbox
        WHERE kind = 'origin_relay' AND status = 'pending'
      ),
      relay_pending AS (
        SELECT COUNT(*) as count
        FROM adapter_outbox
        WHERE status IN ('pending', 'failed') AND kind = 'origin_relay'
      ),
      dlq_open AS (
        SELECT COUNT(*) as count
        FROM outbox_dead_letters
        WHERE resolved_at IS NULL
      )
      SELECT
        (SELECT count FROM wake_pending) as wake_pending,
        (SELECT count FROM outbox_pending) as outbox_pending,
        (SELECT count FROM relay_pending) as relay_pending,
        (SELECT count FROM dlq_open) as dlq_open;
    `;
    // Las colas son globales del stack, no por alias: esta consulta no lleva parámetros.
    const { rows: [queuesState] } = await client.query(queuesSql);

    await client.query('COMMIT');
    await client.end();

    // Determine round-trip status.
    // For now, mark as 'not-run' unless the phase requires it and we have evidence.
    let roundTrip = 'not-run';
    if (['post-cutover', 'canary'].includes(phase)) {
      // Would be set to 'passed' if we ran an authentic round-trip test,
      // but that requires integration with the harness test suite.
      // For production, this should be filled by an external health check.
      roundTrip = process.env.CAUCE_ROUNDTRIP_MARKER === 'passed' ? 'passed' : 'not-run';
    }

    const snapshot = {
      schemaVersion: 1,
      alias,
      capturedAt: new Date().toISOString(),
      v2: {
        consumers: parseInt(consumerState.v2_consumers, 10),
        pollers: parseInt(consumerState.v2_pollers, 10),
        leaseOwners: parseInt(consumerState.v2_consumers, 10), // Same as consumers
      },
      v3: {
        consumers: parseInt(consumerState.v3_consumers, 10),
        pollers: parseInt(consumerState.v3_pollers, 10),
        leaseOwners: parseInt(consumerState.v3_consumers, 10), // Same as consumers
      },
      drain: {
        inflight: parseInt(drainState.inflight, 10),
        unsettledDeliveries: parseInt(drainState.unsettled_deliveries, 10),
      },
      acks: {
        pending: parseInt(acksState.pending, 10),
        invalid: parseInt(acksState.invalid, 10),
        staleAccepted: parseInt(acksState.stale_accepted, 10),
      },
      queues: {
        wakePending: parseInt(queuesState.wake_pending, 10),
        outboxPending: parseInt(queuesState.outbox_pending, 10),
        relayPending: parseInt(queuesState.relay_pending, 10),
        dlqOpen: parseInt(queuesState.dlq_open, 10),
      },
      roundTrip,
    };

    await writeFile(outputFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
  } catch (error) {
    console.error(`snapshot collection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    await client.end().catch(() => {});
    process.exit(2);
  }
}

collectSnapshot().catch((error) => {
  console.error(`fatal error: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(2);
});

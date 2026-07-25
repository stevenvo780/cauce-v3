# Cauce V3 Migration Gate Snapshot Contract

## Overview

The migration gate snapshot is a JSON document that captures the state of a Cauce V3 runtime alias at a specific point in time, enabling validation of safe transitions during cutover, rollback, and ongoing monitoring.

## Schema Definition

See `/workspace/cauce-v3/ops/schemas/gate-snapshot.schema.json` for the authoritative JSON Schema.

## Snapshot Structure

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | integer | Always `1`. Used for schema evolution. |
| `alias` | string | Alias name (matches `/^[a-z][a-z0-9-]*$/`). Identifies the runtime. |
| `capturedAt` | string (RFC3339) | Timestamp when snapshot was captured (ISO 8601). Must be within `CAUCE_GATE_MAX_AGE_SECONDS` of validation time (default 120s). |
| `v2` | object | Consumer state for V2 runtime (legacy). See `consumerState` below. |
| `v3` | object | Consumer state for V3 runtime (current). See `consumerState` below. |
| `drain` | object | Delivery drain metrics. See below. |
| `acks` | object | Acknowledgment state. See below. |
| `queues` | object | Outbox queue state. See below. |
| `roundTrip` | string | Result of authentic round-trip validation: `"passed"`, `"failed"`, or `"not-run"`. |

### Consumer State (`v2` and `v3`)

Represents the active consumer/poller landscape for a single runtime version.

```json
{
  "consumers": 0,
  "pollers": 0,
  "leaseOwners": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `consumers` | integer | Count of active consumer processes with valid leases in `connection_leases` table. Must be ≤ 1 for safety (one exclusive consumer per alias). |
| `pollers` | integer | Count of distinct processes actively polling deliveries (status in `leased`, `accepted`, `started`). Must be ≤ 1. |
| `leaseOwners` | integer | Count of processes holding active leases. Must equal `consumers` (redundant for gate validation but required by schema). Must be ≤ 1. |

**Invariants:**
- `consumers <= 1` and `pollers <= 1` and `leaseOwners <= 1` (no duplicates per version)
- `leaseOwners <= consumers` (every owner must be a consumer)
- V2 and V3 must not overlap: if V2.consumers > 0, then V3.consumers must be 0 (and vice versa for pollers)

### Drain State

Metrics for delivery in-flight and settlement:

```json
{
  "inflight": 0,
  "unsettledDeliveries": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `inflight` | integer | Count of deliveries in transient states: `leased`, `accepted`, or `started`. Indicates work in progress. |
| `unsettledDeliveries` | integer | Count of `delivery_acks` records with `applied = false`. Indicates ACKs awaiting processing. |

### Acknowledgment State

Health of the ACK pipeline:

```json
{
  "pending": 0,
  "invalid": 0,
  "staleAccepted": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pending` | integer | Count of delivery_acks not yet applied. Should be zero before cutover/rollback. |
| `invalid` | integer | Count of inconsistent ACKs (e.g., accepted but delivery is terminal or orphaned). Should always be zero. |
| `staleAccepted` | integer | Count of ACKs marked `accepted` but older than 5 minutes and delivery is still inflight. Indicates stalled processing. |

### Queue State

Pending work in adapter outbox and dead-letter queues:

```json
{
  "wakePending": 0,
  "outboxPending": 0,
  "relayPending": 0,
  "dlqOpen": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `wakePending` | integer | Count of `adapter_outbox` rows with `kind = 'wake'` and `status = 'pending'`. Work waiting to wake agents. |
| `outboxPending` | integer | Count of `adapter_outbox` rows with `kind = 'origin_relay'` and `status = 'pending'`. Relayed messages queued. |
| `relayPending` | integer | Count of `adapter_outbox` rows with `status IN ('pending', 'failed')`. Broader set of relay work. |
| `dlqOpen` | integer | Count of `outbox_dead_letters` rows with `resolved_at IS NULL`. Unresolved dead-letter entries. |

### Round-Trip Status

Captures result of authentic end-to-end validation:

```json
{
  "roundTrip": "passed" | "failed" | "not-run"
}
```

| Value | Meaning |
|-------|---------|
| `"passed"` | An authentic round-trip test (message sent through full path, processed, acknowledged) completed successfully. |
| `"failed"` | A round-trip test was attempted but failed (timeout, ACK not received, or delivery error). |
| `"not-run"` | No round-trip test was executed (phase does not require it, or harness unavailable). |

## Gate Validation Rules by Phase

### Preflight (Pre-Cutover Verification)

**Purpose:** Verify system readiness before cutover begins.

**No specific gate rules** — preflight is a pre-flight check phase. Snapshot is collected but no assertions are applied.

### Drain (Pre-Cutover, After V2 Stop)

**Purpose:** Confirm all deliveries drained before V3 starts.

**Requirements:**
- `v2.consumers = 0, v2.pollers = 0, v2.leaseOwners = 0` (V2 must be completely inactive)
- `v3.consumers = 0, v3.pollers = 0, v3.leaseOwners = 0` (V3 not yet started)
- `drain.inflight = 0` (all deliveries settled)
- `drain.unsettledDeliveries = 0` (all ACKs applied)
- `acks.pending = 0` (no pending ACKs)
- `acks.invalid = 0` (no inconsistent ACKs)
- `queues.dlqOpen = 0` (all dead letters resolved)

**Rationale:** Ensures clean state before V3 initialization; no in-flight work can be lost.

### Post-Cutover (After V3 Starts)

**Purpose:** Verify V3 is sole consumer and delivery system is healthy.

**Requirements:**
- `v2.consumers = 0, v2.pollers = 0, v2.leaseOwners = 0` (V2 remains inactive)
- `v3.consumers = 1, v3.pollers = 1, v3.leaseOwners = 1` (exactly one V3 consumer active)
- `drain.inflight` and `drain.unsettledDeliveries` may be non-zero (new work arriving)
- `queues.wakePending <= CAUCE_MAX_WAKE_PENDING` (backlog within limits; default 0)
- `queues.outboxPending <= CAUCE_MAX_OUTBOX_PENDING` (default 0)
- `queues.relayPending <= CAUCE_MAX_RELAY_PENDING` (default 0)
- `acks.pending = 0` (ACK pipeline clean)
- `acks.invalid = 0` (no corruption)
- `queues.dlqOpen = 0` (no dead letters)
- `roundTrip = "passed"` (end-to-end validation succeeded)

**Rationale:** V3 is live and handling traffic; round-trip proof confirms functional correctness.

### Canary (Monitoring During V3 Operation)

**Purpose:** Ongoing health monitoring post-cutover.

**Requirements:** Same as post-cutover. Canary allows operators to monitor gate state periodically and alert if thresholds are breached.

### Rollback-Drain (Before Rollback to V2)

**Purpose:** Confirm V3 is quiet before disabling.

**Requirements:**
- `v2.consumers = 0, v2.pollers = 0, v2.leaseOwners = 0` (V2 remains off)
- `v3.consumers = 1, v3.pollers = 1, v3.leaseOwners = 1` (V3 still active)
- `drain.inflight = 0` (all deliveries drained)
- `drain.unsettledDeliveries = 0` (all ACKs applied)
- `acks.pending = 0` (clean pipeline)
- `acks.invalid = 0`
- `queues.dlqOpen = 0`

**Rationale:** V3 shuts down only when all in-flight work is settled; no data loss.

### Rollback-Ready (After V3 Stopped and Disabled)

**Purpose:** Confirm safe to re-enable V2.

**Requirements:**
- `v2.consumers = 0, v2.pollers = 0, v2.leaseOwners = 0` (V2 still off, but will be re-enabled)
- `v3.consumers = 0, v3.pollers = 0, v3.leaseOwners = 0` (V3 completely down)
- `drain.inflight = 0` (no lingering work)
- `drain.unsettledDeliveries = 0`
- `acks.pending = 0`
- `acks.invalid = 0`
- `queues.dlqOpen = 0`

**Rationale:** Both V2 and V3 are off; state is clean for V2 re-entry.

### Watchdog (Continuous Monitoring)

**Purpose:** Ongoing health check during steady state (V3 live).

**Requirements:** Same as post-cutover and canary. Runs periodically (e.g., every 5 minutes).

### Reconciler (Periodic State Reconciliation)

**Purpose:** Detect and alert on state drift.

**Requirements:** Same as post-cutover and canary. Runs less frequently (e.g., every 10 minutes) for reconciliation/audit purposes.

## Data Source Mapping

### PostgreSQL Tables

The collector queries the following tables in **read-only mode**:

| Table | Query Purpose |
|-------|---------------|
| `connection_leases` | Consumer/poller counts (v2 vs v3 by instance_id pattern) |
| `deliveries` | In-flight count (status in 'leased','accepted','started'); poller count (distinct consumer_instance_id) |
| `delivery_acks` | Unsettled and invalid ACK counts (applied, status, age checks) |
| `adapter_outbox` | Wake/relay pending counts (kind and status filters) |
| `outbox_dead_letters` | DLQ open count (resolved_at IS NULL) |

### Version Discrimination (V2 vs V3)

V2 vs V3 is identified by the `instance_id` field in `connection_leases` and `consumer_instance_id` in `deliveries`:

- **V3 Patterns:**
  - Starts with `systemd-` (host-native)
  - Contains `-container-` (container runtime)
  - Starts with `cauce-v3-` (modern naming)
- **V2 Patterns:**
  - Any other format (legacy identifiers)
  - NULL consumer_instance_id (orphaned/old)

## Collector Implementation

The gate collector (`ops/scripts/gate-collector.mjs`) performs these queries:

1. **Consumer state (v2/v3):** Counts from `connection_leases` with valid `lease_until`, split by instance_id pattern.
2. **Pollers (v2/v3):** Distinct `consumer_instance_id` counts in inflight deliveries, split by pattern.
3. **Drain state:** Count inflight deliveries and unapplied ACKs.
4. **ACK state:** Pending (not applied), invalid (inconsistent), and stale accepted (age > 5 min).
5. **Queue state:** Counts from `adapter_outbox` and `outbox_dead_letters` by kind/status.
6. **Round-trip:** Set to `"passed"` if `CAUCE_ROUNDTRIP_MARKER` env var is set; otherwise `"not-run"`.

## Time Sensitivity

- **capturedAt age:** Snapshot is considered stale if older than `CAUCE_GATE_MAX_AGE_SECONDS` (default 120s). Allows ~2 minute window for gate execution.
- **Stale accepted ACKs:** Flagged if older than 5 minutes and delivery is still inflight (indicates stuck processing).

## Future Enhancements

1. **Alias enumeration:** Currently hardcoded in timer service. Consider externalizing to a config file.
2. **Selective validation:** Allow different gate thresholds per alias or runtime family.
3. **Round-trip integration:** Integrate with authentic harness to auto-populate round-trip status.
4. **Observability:** Export gate metrics to monitoring system (Prometheus, DataDog, etc.).

## Estado real de ejecución — verificado 2026-07-25

El colector fue **probado contra la base productiva** (lectura, `BEGIN READ ONLY`) y produce un
snapshot válido contra `ops/schemas/gate-snapshot.schema.json`:

```json
{"schemaVersion":1,"alias":"argos","v2":{"consumers":0,"pollers":0,"leaseOwners":0},
 "v3":{"consumers":1,"pollers":0,"leaseOwners":1},"drain":{"inflight":0,"unsettledDeliveries":0},
 "acks":{"pending":0,"invalid":0,"staleAccepted":0},
 "queues":{"wakePending":0,"outboxPending":0,"relayPending":0,"dlqOpen":9},"roundTrip":"not-run"}
```

**Pero todavía NO se puede instalar en kratos tal cual.** Dos bloqueos verificados:

1. `ops/` es cero-dependencias por convención: no tiene `package.json` ni `node_modules`, y el
   resto de los scripts de ops evita cualquier driver (ver `ops/scripts/check-postgres-tls.mjs`).
   El colector importa `pg`, que sólo resuelve dentro de los paquetes del workspace.
   (La entrega original importaba `postgres`, que no es dependencia de este monorepo en absoluto.)
2. kratos tiene `node` pero **no tiene `psql`**, así que tampoco sirve la vía por subproceso que
   usan los demás scripts.

Opciones, a decidir antes de instalar:

- **(a)** Correr el colector en `agora-storage`, donde viven la DB y `psql`, y que kratos consuma el
  snapshot. Es lo más coherente con el resto de la operación, pero acopla el gate a otro host.
- **(b)** Reescribirlo sin driver, invocando `psql` por subproceso, e instalar `psql` en kratos.
  Mantiene la convención cero-dependencias de `ops/`.
- **(c)** Vendorizar `pg` dentro del bundle de ops. Rompe la convención y agrega superficie a
  mantener y a digestear.

Recomendación: **(b)**. Preserva la invariante de `ops/` y deja el gate ejecutable donde viven las
units que audita. Hasta resolver esto, `cutover.sh`, `cutover-rollback.sh`, `canary.sh`,
`preflight.sh` y `guard-check.sh` siguen sin poder ejecutarse en producción.

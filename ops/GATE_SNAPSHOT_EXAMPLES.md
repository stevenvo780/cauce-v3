# Gate Snapshot Examples

## Example Snapshots by Phase

### Phase: Drain (Pre-Cutover, Both V2 and V3 Inactive)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:30:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "drain": {
    "inflight": 0,
    "unsettledDeliveries": 0
  },
  "acks": {
    "pending": 0,
    "invalid": 0,
    "staleAccepted": 0
  },
  "queues": {
    "wakePending": 0,
    "outboxPending": 0,
    "relayPending": 0,
    "dlqOpen": 0
  },
  "roundTrip": "not-run"
}
```

**Validation:** All zeros except roundTrip. This snapshot will pass `migration-gate.mjs drain kant /tmp/drain.json`.

---

### Phase: Post-Cutover (V3 Active, Round-Trip Passed)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 1
  },
  "drain": {
    "inflight": 42,
    "unsettledDeliveries": 3
  },
  "acks": {
    "pending": 0,
    "invalid": 0,
    "staleAccepted": 0
  },
  "queues": {
    "wakePending": 87,
    "outboxPending": 12,
    "relayPending": 45,
    "dlqOpen": 0
  },
  "roundTrip": "passed"
}
```

**Validation:**
- V2 all zeros ✓
- V3 exactly 1 on each ✓
- drain fields non-zero (new work arriving) ✓
- acks.pending = 0 ✓
- queues within thresholds (assuming defaults; check against CAUCE_MAX_*) ✓
- roundTrip = "passed" ✓

This snapshot will pass `migration-gate.mjs post-cutover kant /tmp/post.json`.

---

### Phase: Canary (Same as Post-Cutover)

```json
{
  "schemaVersion": 1,
  "alias": "leibniz",
  "capturedAt": "2026-07-25T10:40:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 1
  },
  "drain": {
    "inflight": 15,
    "unsettledDeliveries": 1
  },
  "acks": {
    "pending": 0,
    "invalid": 0,
    "staleAccepted": 0
  },
  "queues": {
    "wakePending": 0,
    "outboxPending": 0,
    "relayPending": 0,
    "dlqOpen": 0
  },
  "roundTrip": "passed"
}
```

Canary allows ongoing monitoring. This snapshot shows healthy state: single V3 consumer, all ACKs clean, queues empty.

---

### Phase: Rollback-Drain (V3 Still Active, All Work Drained)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T11:00:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 1
  },
  "drain": {
    "inflight": 0,
    "unsettledDeliveries": 0
  },
  "acks": {
    "pending": 0,
    "invalid": 0,
    "staleAccepted": 0
  },
  "queues": {
    "wakePending": 0,
    "outboxPending": 0,
    "relayPending": 0,
    "dlqOpen": 0
  },
  "roundTrip": "not-run"
}
```

**Validation:**
- V2 all zeros ✓
- V3 exactly 1 on each ✓
- All drain fields zero (work fully settled) ✓
- All ACKs zero ✓
- No roundTrip required ✓

This snapshot will pass `migration-gate.mjs rollback-drain kant /tmp/rollback-drain.json`, allowing V3 to be disabled safely.

---

### Phase: Rollback-Ready (Both V2 and V3 Inactive)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T11:05:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "drain": {
    "inflight": 0,
    "unsettledDeliveries": 0
  },
  "acks": {
    "pending": 0,
    "invalid": 0,
    "staleAccepted": 0
  },
  "queues": {
    "wakePending": 0,
    "outboxPending": 0,
    "relayPending": 0,
    "dlqOpen": 0
  },
  "roundTrip": "not-run"
}
```

**Validation:** Identical to drain phase. Both V2 and V3 inactive, all work settled. Safe to re-enable V2.

---

## Failure Examples

### Example: V3 Has No Lease (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 0
  },
  ...
}
```

**Validation Failure:** Line 65 of migration-gate.mjs:
```
v3 lease owner has no consumer
```

The V3 process has one consumer lease, but its leaseOwner count is 0. This indicates the consumer lost its lease or the instance registered but didn't claim ownership. **Gate fails; cutover aborts.**

---

### Example: Duplicate Consumers (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 2,
    "pollers": 1,
    "leaseOwners": 2
  },
  ...
}
```

**Validation Failure:** Line 64 of migration-gate.mjs:
```
v3 has duplicate consumers, pollers, or lease owners
```

Two V3 processes have active leases. This violates the single-consumer guarantee. **Gate fails; operation blocked.**

---

### Example: V2 and V3 Overlap (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  "v2": {
    "consumers": 1,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 1
  },
  ...
}
```

**Validation Failure:** Line 68 of migration-gate.mjs:
```
V2 and V3 consumers/pollers overlap
```

Both V2 and V3 consumers are active. This is a critical error; deliveries would be claimed by both versions. **Gate fails; operation refused.**

---

### Example: ACK Pipeline Broken (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  "v2": {
    "consumers": 0,
    "pollers": 0,
    "leaseOwners": 0
  },
  "v3": {
    "consumers": 1,
    "pollers": 1,
    "leaseOwners": 1
  },
  "drain": {
    "inflight": 10,
    "unsettledDeliveries": 5
  },
  "acks": {
    "pending": 3,
    "invalid": 0,
    "staleAccepted": 0
  },
  ...
}
```

**Validation Failure:** Line 87 of migration-gate.mjs:
```
acks.pending must be zero
```

Three ACKs are still waiting to be applied before the cutover is considered clean. The gate enforces zero pending ACKs in post-cutover to ensure a clean pipeline. **Gate fails; must wait for ACKs to drain.**

---

### Example: Stale ACK (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  ...
  "acks": {
    "pending": 0,
    "invalid": 1,
    "staleAccepted": 0
  },
  ...
}
```

**Validation Failure:** Line 70 of migration-gate.mjs:
```
acks.invalid must be zero
```

One ACK is in an inconsistent state (e.g., marked accepted but the delivery was terminated or lost its lease). This indicates data corruption or a crash mid-ACK. **Gate fails; manual intervention required.**

---

### Example: Backlog Exceeds Threshold (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  ...
  "queues": {
    "wakePending": 2500,
    "outboxPending": 12,
    "relayPending": 45,
    "dlqOpen": 0
  },
  ...
}
```

Assuming `CAUCE_MAX_WAKE_PENDING=1000` (default):

**Validation Failure:** Line 82 of migration-gate.mjs:
```
wake backlog exceeds gate
```

Too many messages are pending wake notifications. This indicates the V3 consumer is overwhelmed or the harness is slow. **Gate fails; must resolve congestion before proceeding.**

---

### Example: Round-Trip Failed (post-cutover)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T10:35:00Z",
  ...
  "roundTrip": "failed"
}
```

**Validation Failure:** Line 88 of migration-gate.mjs:
```
authentic round-trip evidence is required
```

A round-trip test was run but failed (timeout, ACK not received, or delivery error). This indicates the V3 consumer is not functional end-to-end. **Gate fails; V3 must be debugged.**

---

### Example: Snapshot Is Stale (any phase)

```json
{
  "schemaVersion": 1,
  "alias": "kant",
  "capturedAt": "2026-07-25T08:00:00Z",
  ...
}
```

If the snapshot was captured 3+ hours ago and the current time is 2026-07-25T10:35:00Z:

**Validation Failure:** Line 52-53 of migration-gate.mjs:
```
gate snapshot is stale or from the future
```

Snapshots older than `CAUCE_GATE_MAX_AGE_SECONDS` (default 120s) are rejected. **Gate fails; new snapshot must be collected.**

---

## Usage in Cutover Scripts

The real workflow is:

```bash
# 1. Collect drain snapshot
node gate-collector.mjs kant /tmp/drain.json drain

# 2. Validate before starting V3
node migration-gate.mjs drain /tmp/drain.json kant
# Output: "gate drain passed for kant" (or fails with a message)

# 3. If pass, proceed with cutover
systemctl --user start cauce-v3-container-kant.service

# 4. Collect post-cutover snapshot
node gate-collector.mjs kant /tmp/post.json post-cutover

# 5. Validate post-cutover
node migration-gate.mjs post-cutover /tmp/post.json kant
# Output: "gate post-cutover passed for kant" (or fails)

# 6. If pass, enable the service (making it auto-restart)
systemctl --user enable cauce-v3-container-kant.service
```

Each gate checkpoint ensures forward progress only when state is provably safe.

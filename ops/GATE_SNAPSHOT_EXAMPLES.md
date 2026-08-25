# Ejemplos de snapshot v2

Snapshot de drain válido:

```json
{
  "schemaVersion": 2,
  "tenant": "Steven",
  "alias": "kant",
  "capturedAt": "2030-01-01T00:00:00.000Z",
  "v2": {"consumers": 0, "pollers": 0, "leaseOwners": 0},
  "v3": {"consumers": 0, "pollers": 0, "leaseOwners": 0},
  "drain": {"inflight": 0, "overdueInflight": 0, "ownershipMismatch": 0},
  "acks": {"rejectedRecent": 0, "staleAccepted": 0},
  "queues": {"wakePending": 0, "outboxPending": 0, "relayPending": 0, "dlqOpen": 7, "dlqNewSinceBaseline": 0},
  "roundTrip": {"status": "not-run", "completedAt": null, "terminalAckApplied": false, "activeLeaseMatch": false}
}
```

`dlqOpen` puede ser distinto de cero porque conserva historia; el gate bloquea sólo
`dlqNewSinceBaseline > 0`.

Snapshot post-cutover válido (timestamps abreviados sólo para ilustrar; deben ser frescos):

```json
{
  "schemaVersion": 2,
  "tenant": "Steven",
  "alias": "kant",
  "capturedAt": "2030-01-01T00:01:00.000Z",
  "v2": {"consumers": 0, "pollers": 0, "leaseOwners": 0},
  "v3": {"consumers": 1, "pollers": 1, "leaseOwners": 1},
  "drain": {"inflight": 0, "overdueInflight": 0, "ownershipMismatch": 0},
  "acks": {"rejectedRecent": 0, "staleAccepted": 0},
  "queues": {"wakePending": 0, "outboxPending": 0, "relayPending": 0, "dlqOpen": 7, "dlqNewSinceBaseline": 0},
  "roundTrip": {"status": "passed", "completedAt": "2030-01-01T00:00:59.000Z", "terminalAckApplied": true, "activeLeaseMatch": true}
}
```

No editar snapshots a mano para aprobar un cambio. El flujo auténtico es:

```sh
export CAUCE_GATE_CAPTURE_PATH=/ruta/release/ops/scripts/gate-collector.mjs
export CAUCE_GATE_PROBE_PATH=/ruta/release/ops/scripts/gate-roundtrip-probe.mjs
ops/scripts/canary.sh kant /ruta/privada/baseline-drain.json
```

El canary crea evidencia 0600 temporal, publica `system.gate.probe`, captura el snapshot y valida
la prueba terminal. Un status `passed` sin `terminalAckApplied` o `activeLeaseMatch` falla.

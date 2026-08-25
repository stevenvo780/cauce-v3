# Contrato de gates de Cauce V3

El snapshot por alias usa `schemaVersion: 2` y se valida con claves exactas. Lo captura
`ops/scripts/gate-collector.mjs` dentro de una sola transacción PostgreSQL
`REPEATABLE READ READ ONLY`; por tanto consumers, ACK, colas y prueba round-trip pertenecen al
mismo corte lógico.

## Campos

- `tenant`, `alias`, `capturedAt`: identidad declarada y tiempo del snapshot.
- `v2` / `v3`: `consumers`, `pollers`, `leaseOwners`. Un poller real requiere lease viva,
  capability `heartbeat`, un heartbeat posterior a `connected_at` y dentro de
  `CAUCE_GATE_POLLER_FRESH_MS`. V3 sólo admite instance IDs `systemd-<alias>` o
  `systemd-container-<alias>`; todo otro owner se clasifica V2.
- `drain`: `inflight`, `overdueInflight`, `ownershipMismatch`.
- `acks`: `rejectedRecent` en la ventana configurada y `staleAccepted`.
- `queues`: wake/outbox/relay pendientes, `dlqOpen` histórico y
  `dlqNewSinceBaseline`. Un DLQ histórico preservado no bloquea; cualquier DLQ creado después del
  baseline sí.
- `roundTrip`: `{status, completedAt, terminalAckApplied, activeLeaseMatch}`.

El baseline es obligatorio en `post-cutover`, `canary`, `watchdog` y `reconciler`. Debe ser un
snapshot v2 del mismo tenant+alias. Los snapshots vencen por `CAUCE_GATE_MAX_AGE_SECONDS` (120 s
por defecto).

## Prueba auténtica reservada

`ops/scripts/gate-roundtrip-probe.mjs` publica exactamente un cuerpo:

```json
{"type":"system.gate.probe","nonce":"<32-hex>","timeout_ms":600000}
```

La identidad es exclusivamente un principal mTLS:

```json
{"tenant_id":"Steven","alias":"gate-probe","session_id":"gate-probe","channel":"gate","roles":["agent"],"permissions":["route","read"]}
```

No lleva `origin`. `gate-probe` no es alias de flota, agent row, membership, lease ni destino. El
gateway exige provider `mtls`, principal y payload exactos. La fila durable usa `Steven:kant` como
actor FK ya declarado y conserva `auth_session_id=gate-probe` / `auth_channel=gate` como prueba de
autoridad. El SDK reconoce el tipo antes de reservar sesión: ACK `accepted` y `done` del claim real,
sin prompt, harness, modelo, reply, messages, notify ni egress. La request se elimina del inbox
durable al terminalizar; queda sólo el resultado mínimo del ACK y el audit de transporte.

El probe usa HTTPS con CA/cert/key por paths, timeouts acotados y evidencia efímera 0600. Canary y
cutover borran su directorio temporal al salir. `CAUCE_ROUNDTRIP_MARKER` está prohibido.

## Reglas por fase

| Fase | Cardinalidad | Drain | Round-trip |
|---|---|---|---|
| `preflight` | sin duplicados ni overlap | ownership/deadline/ACK/DLQ delta sanos | no requerido |
| `drain` | V2=0 y V3=0 | `inflight=0` | no requerido |
| `post-cutover`, `canary` | V2=0; V3 consumer/poller/owner=1 | invariantes globales | `passed` con ACK aplicado y misma lease viva |
| `watchdog`, `reconciler` | V2=0; V3 consumer/poller/owner=1 | invariantes globales | no crea trabajo; usa baseline |
| `rollback-drain` | V2=0; V3=1/1/1 | `inflight=0` | no requerido |
| `rollback-ready` | V3=0 | `inflight=0` | no requerido |

En todas las fases: cero `overdueInflight`, `ownershipMismatch`, `rejectedRecent`, `staleAccepted`
y `dlqNewSinceBaseline`; nunca dos consumers/pollers/owners ni overlap V2/V3. Post-cutover y guards
aplican además los umbrales `CAUCE_MAX_{WAKE,OUTBOX,RELAY}_PENDING`.

## Gates de release y flota

El snapshot de flota usa `schemaVersion: 3`: agents, memberships, rolePolicies y leases. La paridad
exige 15 agentes habilitados, un principal de sistema (`quota-collector`), tres históricos
deshabilitados y permisos exactos de `agent_notify` (`route/read/notify=true`, `control=false`). Ni
`quota-collector` ni `gate-probe` aparecen en `routing_targets` o destinos ordinarios.

`physical-fleet-gate.py` enumera sólo nombres Docker y exige que todo container físico declarado
exista antes del gate de migración. No exige que las units por alias estén activas.

La única excepción de salud es `maintenance-zeus`: requiere `CAUCE_CHANGE_ID` no secreto y
`CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:<cambio>`, y además prueba que Zeus está realmente
offline. Nunca relaja el modo `final`; tras mantenimiento sigue siendo obligatorio un gate final
estricto.

## Límite de integridad histórica

El ledger atómico protege migraciones nuevas y existe una huella estructural especial para 024,
pero 001–023 no tienen hoy digest histórico completo. Un nombre en `schema_migrations` no prueba sus
bytes. No afirmar “integridad total” sin comparar, en la misma versión de PostgreSQL, un schema
canónico normalizado de una base fresca 001–029 contra un restore real migrado a 029. Hasta que ese
artefacto exista, restore drill, invariantes y gates operativos son cobertura complementaria, no
equivalencia criptográfica del histórico.

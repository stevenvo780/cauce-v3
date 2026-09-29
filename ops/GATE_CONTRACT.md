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
{"tenant_id":"<tenant>","alias":"gate-probe","session_id":"gate-probe","channel":"gate","roles":["agent"],"permissions":["route","read"]}
```

No lleva `origin`. `gate-probe` no es alias de flota, agent row, membership, lease ni destino. El
gateway exige provider `mtls`, principal y payload exactos —incluidos el tenant y la sala de origen
que fija `services/gateway/src/routes/core/publish.ts`, más `lane` `interactive`, `priority` `-100`
y una `idempotency_key` `gate:<tenant>:<alias>:<nonce>`—. Como `gate-probe` no tiene agent row, la
fila durable reutiliza como actor FK un alias de agente ya declarado (el mismo fichero fija cuál) y
conserva `auth_session_id=gate-probe` / `auth_channel=gate` como prueba de autoridad. El SDK
reconoce el tipo antes de reservar sesión: ACK `accepted` y `done` del claim real, sin prompt,
harness, modelo, reply, messages, notify ni egress. La request se elimina del inbox
durable al terminalizar; queda sólo el resultado mínimo del ACK y el audit de transporte.

El probe usa HTTPS con CA/cert/key por paths, timeouts acotados y evidencia efímera 0600. Canary y
cutover borran su directorio temporal al salir. `CAUCE_ROUNDTRIP_MARKER` está prohibido.

Si falta esta identidad, el dueño debe autorizar su emisión local con
`ops/scripts/provision-gate-identity.py --output-dir <directorio-nuevo> --ca-cert <CA-publica>
--ca-key <clave-CA-local> --identities-dir <registro-mTLS>`. La clave permanece en el host emisor,
modo 0400; el script no reemplaza credenciales existentes ni crea un agente de flota. Registra
únicamente el principal anterior mediante lock y CAS. Una repetición exacta es idempotente; si
falló el registro después de emitir, reutiliza el mismo par validado. La vigencia queda acotada
por la CA. Nunca usar una identidad de agente o de operador para suplir este probe.

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

El snapshot de flota es `ops/flota.json` (`schemaVersion: 1`), exportado de PostgreSQL por
`export-fleet-snapshot.py`: los alias habilitados van en `fleet`, los deshabilitados en `retired`,
la colocación física en `placement` y los principales de sistema en `systemPrincipals`.

La paridad no se expresa en números, sino como igualdad de conjuntos: se vuelve a exportar el
snapshot y **cualquier** diferencia contra el versionado es un diff que bloquea, y `validate.sh`
compara byte a byte los derivados (`container-aliases.json`, `manifests/*.yaml`, units generadas)
contra lo que se regenera desde ese snapshot — un alta, baja o cambio de tenant/room/harness
aplicado en una sola capa no pasa. La fila `agent_notify` de `role_policies` conserva además su
contrato exacto (`route`/`read`/`notify` en true, `control` en false;
`packages/store/migrations/027_rol_agent_notify.sql`).

Los principales técnicos cerrados —`gate-probe` y `quota-collector`, la constante
`SYSTEM_PRINCIPAL_ALIASES` de `packages/protocol/src/schemas/messages.ts`— no son alias de flota:
nunca son destino ni aparecen en `routing_targets`.

`physical-fleet-gate.py` enumera sólo nombres Docker y exige que todo container físico declarado
exista antes del gate de migración. No exige que las units por alias estén activas.

## Límite de integridad histórica

El ledger atómico protege migraciones nuevas y existe una huella estructural especial para 024,
pero 001–023 no tienen hoy digest histórico completo. Un nombre en `schema_migrations` no prueba sus
bytes. No afirmar “integridad total” sin comparar, en la misma versión de PostgreSQL, un schema
canónico normalizado de una base fresca 001–029 contra un restore real migrado a 029. Hasta que ese
artefacto exista, restore drill, invariantes y gates operativos son cobertura complementaria, no
equivalencia criptográfica del histórico.

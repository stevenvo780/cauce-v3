# Runbook: preflight, canary, cutover y rollback por alias

## Alcance y collector

Los scripts solo gestionan la unidad V3. Nunca detienen, arrancan ni escriben V2. Un collector externo, read-only y específico del entorno se configura en `CAUCE_GATE_CAPTURE_PATH`; recibe `ALIAS OUTPUT.json PHASE` y escribe el schema exacto `schemas/gate-snapshot.schema.json`. No debe imprimir payloads, tokens, sesiones ni headers.

Cada snapshot fresco incluye consumers, pollers y lease owners V2/V3; inflight/unsettled; ACK pending/invalid/stale; wake/outbox/relay; DLQ y resultado de round-trip. `migration-gate.mjs` rechaza snapshots viejos, alias incorrecto, campos extra, dos consumers/pollers, overlap V2/V3, ACK viejo aceptado o DLQ abierta.

## Preparación

```sh
python3 ops/scripts/validate-manifests.py
python3 ops/scripts/generate-units.py
# instalar unidades generadas; crear usuario cauce-v3 y env 0600 por alias
ops/scripts/preflight.sh jarvis /ruta/snapshot-preflight.json
```

El env privado resuelve los nombres del manifest: relay `wss://`, token, cert, key, CA y wrapper ejecutable absolutos. El wrapper encapsula el comando auténtico del runtime; el generador no inventa argv ni lee sesiones. El lock local del state dir impide un segundo proceso en el mismo host.

El manifest Hermes de `argos` declara `operationalModelEnv: HERMES_INFERENCE_MODEL`.
Su env privado debe definir ese selector con el modelo operativo elegido; ni el
manifest ni las unidades generadas fijan un proveedor o valor de modelo.

## Drain y cutover

1. El owner V2 bloquea ingress nuevo y drena su consumer/poller fuera de estos scripts.
2. Capturar snapshot `drain`: V2=0, V3=0, inflight/unsettled/ACK pending=0.
3. Ejecutar con confirmación ligada a change ID:

```sh
export CAUCE_CHANGE_ID=CHG-123
export CAUCE_CUTOVER_CONFIRM=cutover:host-native:jarvis:CHG-123
export CAUCE_GATE_CAPTURE_PATH=/usr/local/libexec/cauce-gate-collector
ops/scripts/cutover.sh host-native jarvis /ruta/snapshot-drain.json
```

El primer parámetro selecciona explícitamente `host-native` o `container`; el script falla si la otra familia está activa o habilitada. Revalida drain, inicia una sola unit, captura estado nuevo y exige exactamente un consumer, poller y lease owner V3, V2 cero, round-trip auténtico, ACK válido y backlog/DLQ en gate. Para `container` también exige el check de digest/proceso del supervisor. Ante error detiene la unit seleccionada.

## Canary

```sh
ops/scripts/canary.sh jarvis /ruta/snapshot-canary.json
```

Mantener al menos dos ventanas de lease/retry antes de subir tráfico. Umbrales default son cero y solo pueden elevarse explícitamente con `CAUCE_MAX_{WAKE,OUTBOX,RELAY}_PENDING` dentro del cambio aprobado.

## Watchdog y reconciler

Instalar `cauce-v3-{watchdog,reconciler}@.{service,timer}`. Crear `/etc/cauce-v3/guards/<alias>.enabled` solo después del cutover y habilitar ambos timers. Watchdog corre cada 30 s; reconciler cada 5 min. Ambos son read-only y fallan ante overlap, lease duplicado, ACK inválido/stale, DLQ o backlog fuera de gate; no intentan auto-reparar ni reinician V2.

## Rollback de alias

Con snapshot live ya drenado (`inflight`, unsettled y ACK pending en cero) y confirmación:

```sh
export CAUCE_CHANGE_ID=CHG-123
export CAUCE_ROLLBACK_CONFIRM=stop-v3:host-native:jarvis:CHG-123
ops/scripts/cutover-rollback.sh host-native jarvis /ruta/snapshot-live.json
```

Usar la misma familia elegida en cutover. El script deshabilita y detiene la unit para impedir auto-resurrection; para `container` exige además el check negativo de metadata/proceso. Luego captura `rollback-ready` y exige V3=0 y drain/ACK terminal. Recién entonces el owner V2 puede restaurar su consumer mediante su procedimiento. Si el gate falla, no arrancar V2.

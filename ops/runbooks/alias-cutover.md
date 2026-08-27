# Runbook: Preflight, Cutover y Rollback por Alias

## Cuándo usar
Ejecutar la transición (cutover) de un alias hacia Cauce V3 (modo `host-native` o `container`), canary y verificación de aislamiento. Caveat operativo: la dual-stack V2/V3 ya no es operativa; aplica exclusivamente como referencia de rollback.

## Pasos
1. Validar manifiestos y generar unidades:
   ```sh
   python3 ops/scripts/validate-manifests.py
   python3 ops/scripts/generate-units.py
   ```
2. Drenar ingress previo y capturar snapshot `drain` (V2=0, V3=0, inflight=0).
3. Ejecutar cutover con confirmación ligada a change ID:
   ```sh
   # [no ejecutable en verificación]
   export CAUCE_CHANGE_ID=CHG-123
   export CAUCE_CUTOVER_CONFIRM=cutover:host-native:jarvis:CHG-123
   export CAUCE_GATE_CAPTURE_PATH=/usr/local/libexec/cauce-gate-collector
   export CAUCE_GATE_PROBE_PATH=/usr/local/libexec/cauce-gate-roundtrip-probe
   ops/scripts/cutover.sh host-native jarvis /ruta/snapshot-drain.json
   ```

## Verificar efecto
1. Ejecutar canary sobre el baseline de cutover:
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/canary.sh jarvis /ruta/baseline-cutover.json
   ```
2. Verificar que exista exactamente un consumer, poller y lease owner V3 sin DLQ nuevo.
3. Confirmar que la unidad systemd está activa:
   ```sh
   # [no ejecutable en verificación]
   systemctl is-active cauce-v3-alias-jarvis.service
   ```
4. Verificar ausencia de overlap o leases duplicadas en base de datos.

## Deshacer
1. Drenar el consumer V3 hasta que `inflight`, unsettled y ACK pending queden en cero.
2. Detener y deshabilitar la unidad V3 para impedir auto-resurrección:
   ```sh
   # [no ejecutable en verificación]
   systemctl disable --now cauce-v3-alias-jarvis.service
   ```
3. Para modo container, verificar ausencia de procesos con el supervisor:
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/container-adapter-supervisor.sh stopped jarvis
   ```
4. Restaurar el estado previo según el procedimiento correspondiente una vez validado el drenado total.

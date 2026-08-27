# Runbook: Telegram Bridge Cutover y Rollback

## Cuándo usar
Activar, actualizar o revertir el puente Telegram V3 (`telegram-bridge`) por alias de forma acumulativa y reversible sin exponer tokens ni credenciales en logs o Git.

## Pasos
1. Generar la configuración con allowlist de identificadores de usuario y chat:
   ```sh
   # [no ejecutable en verificación]
   python3 ops/scripts/generate-telegram-config.py \
     --aliases "$ALIAS" \
     --allowlist-file /tmp/allow.$ALIAS.json \
     --output "$CAUCE_TELEGRAM_RUNTIME_DIR/config.json"
   ```
2. Provisionar `<alias>.token` (modo `0600`, no symlink, uid 1000) y marcador `v2-poller-disabled:<alias>` en `$CAUCE_TELEGRAM_RUNTIME_DIR`.
3. Ejecutar preflight libre de secretos:
   ```sh
   # [no ejecutable en verificación]
   python3 ops/scripts/telegram-cutover-preflight.py \
     --config "$CAUCE_TELEGRAM_RUNTIME_DIR/config.json" \
     --aliases "$ALIAS" \
     --runtime-dir "$CAUCE_TELEGRAM_RUNTIME_DIR"
   ```
4. Actualizar el selector acumulativo y recrear la única instancia del puente:
   ```sh
   # [no ejecutable en verificación]
   export CAUCE_TELEGRAM_ALIASES="$ALIAS"
   docker compose -f deploy/compose.yaml --profile telegram up -d --force-recreate telegram-bridge
   ```

## Verificar efecto
1. Comprobar salud y readiness del contenedor:
   ```sh
   # [no ejecutable en verificación]
   docker compose -f deploy/compose.yaml ps telegram-bridge
   ```
2. Consultar métricas en `/metrics` y verificar:
   - `updates_allowed` y `egress_sent` incrementan tras el mensaje de prueba.
   - `poll_fenced` permanece estable.
   - `egress_ambiguous = 0` y `egress_dead = 0`.
3. Esperar al menos dos ventanas de lease (`poll_lease_ms`, default 60s) antes de sumar más alias o tráfico.

## Deshacer
1. Drenar entregas pendientes y relays del alias hasta que no quede inflight ni ACK pendiente.
2. Quitar el alias de `CAUCE_TELEGRAM_ALIASES` y recrear la instancia. Si se retiran todos los alias, detener explícitamente el perfil (un selector vacío activa todos los alias):
   ```sh
   # [no ejecutable en verificación]
   docker compose -f deploy/compose.yaml --profile telegram stop telegram-bridge
   ```
3. Eliminar el marcador de shutdown:
   ```sh
   # [no ejecutable en verificación]
   rm -f "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled"
   ```

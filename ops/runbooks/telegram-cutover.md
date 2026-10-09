# Runbook: Telegram Bridge Cutover y Rollback

## Cuándo usar
Activar, actualizar o revertir el puente Telegram V3 (`telegram-bridge`) por alias de forma acumulativa y reversible sin exponer tokens ni credenciales en logs o Git.

## Pasos
1. Publicar la fila del alias y su token con el mismo escritor. `publish-telegram-token.py` genera la
   configuración en una copia privada (con allowlist de identificadores de usuario y chat), lee de la
   fila generada dónde va el token, lo deja en `$CAUCE_TELEGRAM_RUNTIME_DIR/<tenant>/<alias>.token`
   (modo `0600`, no symlink, uid 1000; directorio `<tenant>/` en `0750`, uid 1000) y solo entonces
   reemplaza `config.json` de forma atómica. Pide el token por la terminal si falta (`--token-file`
   para rotarlo desde un fichero); nunca lo imprime:
   ```sh
   # [no ejecutable en verificación]
   printf 'v2-poller-disabled:%s\n' "$ALIAS" > "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled"
   python3 ops/scripts/publish-telegram-token.py \
     --runtime-dir "$CAUCE_TELEGRAM_RUNTIME_DIR" \
     --alias "$ALIAS" \
     --allowlist-file /tmp/allow.$ALIAS.json \
     --preflight
   ```
   `cauce <alias> aprovisionar` (pieza 5) ejecuta este mismo escritor. Mientras alguna fila de
   `config.json` siga en la disposición plana (`/run/cauce-telegram/<alias>.token`), el escritor
   mantiene también `<alias>.token` como enlace duro al mismo inodo, así que la configuración en
   curso y cualquier vuelta atrás siguen encontrando el token.
2. Marcadores: `v2-poller-disabled:<alias>` sigue en la disposición plana,
   `$CAUCE_TELEGRAM_RUNTIME_DIR/<alias>.disabled`. No es un secreto y el puente exige alias únicos por
   configuración, así que no necesita directorio por tenant.
3. Ejecutar preflight libre de secretos (`--preflight` del paso 1 ya lo hace antes del reemplazo; este
   paso lo repite contra la configuración publicada):
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

## Migrar una instalación plana a `<tenant>/<alias>.token`
El puente falla cerrado para **todos** los bots si falta un solo token, y `deploy.sh` no regenera
`config.json`. Por eso la migración va en dos tiempos y el orden no se invierte:
1. Enlaces duros, sin tocar `config.json` (como root o uid 1000). Por cada fila, crear el directorio
   del tenant y un segundo nombre del mismo inodo, sin copiar el secreto ni cambiar su modo:
   ```sh
   # [no ejecutable en verificación]
   cd "$CAUCE_TELEGRAM_RUNTIME_DIR"
   python3 - config.json <<'PY' | while IFS=$'\t' read -r tenant alias; do
   import json, sys
   for row in json.load(open(sys.argv[1]))["aliases"]:
       print(row["tenant_id"], row["token_file"].rsplit("/", 1)[1][:-len(".token")], sep="\t")
   PY
     install -d -o 1000 -g 1000 -m 0750 "$tenant"
     [ -e "$tenant/$alias.token" ] || ln "$alias.token" "$tenant/$alias.token"
   done
   ```
2. Verificar que cada fila tiene sus dos nombres en el mismo inodo (`stat -c '%h %i %n'` muestra
   `2` enlaces y el mismo inodo) y correr el preflight sobre una copia de `config.json` con las rutas
   `<tenant>/<alias>.token`.
3. Reemplazar `config.json` por la versión con rutas por tenant (`generate-telegram-config.py` sin
   `--aliases` con la misma allowlist, o `publish-telegram-token.py` alias por alias) con un
   `mv` atómico, y recrear el puente.
4. Los nombres planos se pueden borrar solo cuando ninguna configuración, copia `.bak` de vuelta
   atrás ni guardia los use. `cauce-v3-medico-monitor` ya lee las dos disposiciones y prefiere la de
   tenant.

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

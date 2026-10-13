# Runbook: Encender un Alias Individual

## Cuándo usar
Encender y validar un alias individual en Cauce V3 de forma aislada, evitando modales interactivos en la TUI y asegurando que no existan consumidores rivales del bot de Telegram.

## Pasos
1. Desactivar modales y prompts interactivos en la configuración del arnés:
   - Claude: en `$CLAUDE_CONFIG_DIR/.claude.json`, fijar `hasCompletedOnboarding: true` y `projects["/workspace"].hasTrustDialogAccepted: true`.
   - Codex: en `config.toml`, fijar `approval_policy = "never"`; en `~/.codex/version.json`, fijar `dismissed_version` igual a `latest_version`.
2. Comprobar que no exista otro consumidor activo para el bot de Telegram:
   ```sh
   # [no ejecutable en verificación]
   docker stop cauce-v3-prod-telegram-bridge-1
   curl -s -o /dev/null -w "%{http_code}\n" --max-time 22 \
     "https://api.telegram.org/bot$TOKEN/getUpdates?timeout=12&limit=5"
   docker start cauce-v3-prod-telegram-bridge-1
   ```
   (Con el puente detenido, un código 409 indica la presencia de un consumidor rival no autorizado).
3. Encender el adaptador del alias. El comando vale cuando `CAUCE_FLEET_RUNTIME_STATE` no está
   definido. Si lo está, `ops/cli/cauce` rechaza `on` y `off` con salida 2 y remite a la consola
   y al coordinator durable:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> on
   ```

## Verificar efecto
1. El CLI no prueba una entrega. No existe el subcomando `probar`: con flota estática cae en
   `no entiendo` y sale 2; con `CAUCE_FLEET_RUNTIME_STATE` definido el rechazo es anterior y
   también sale 2. Lo que el CLI sí muestra es el estado y las sesiones del paso siguiente.
2. Inspeccionar estado y sesiones compartidas:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> estado
   ops/cli/cauce <alias> sesiones
   ```
3. Verificar en base de datos que `channel_bridge_leases.lease_until` se renueva regularmente.

## Deshacer
1. Apagar el adaptador y los procesos asociados. Con `CAUCE_FLEET_RUNTIME_STATE` definido,
   `off` sale 2 igual que `on` y hay que apagarlo desde la consola:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> off
   ```
2. Verificar en `/proc` o con el supervisor que el proceso del adaptador terminó por completo.

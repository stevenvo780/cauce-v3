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
3. Encender el adaptador del alias:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> on
   ```

## Verificar efecto
1. Probar entrega y respuesta real en el gateway:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce probar <alias>
   ```
2. Inspeccionar estado y sesiones compartidas:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> estado
   ops/cli/cauce <alias> sesiones
   ```
3. Verificar en base de datos que `channel_bridge_leases.lease_until` se renueva regularmente.

## Deshacer
1. Apagar el adaptador y los procesos asociados:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce <alias> off
   ```
2. Verificar en `/proc` o con el supervisor que el proceso del adaptador terminó por completo.

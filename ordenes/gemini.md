# Gemini — ORDEN ACTIVA (grande): cerrar tests/ + LA PRUEBA DE LOS 5 ESCENARIOS (antesala del despliegue)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → `docs/flota-y-participantes.md` → esta orden. Tu nocturna: dispatcher a cero, zonas promovidas al gate — bien. Queda `tests/` (368). Zonas EXCLUSIVAS: `tests/**` · `console/**` · `services/{terminal-relay,telegram-bridge,dispatcher}/**` · `ops/runbooks/**`. El despliegue arranca en cuanto cierres esto: velocidad con evidencia.

## Tarea 1 — `tests/` a CERO (368) — oleadas de 4 por directorio
`tests/unit` · `tests/gateway-hardening` · `tests/store-hardening` · `tests/integration`+`e2e` · `tests/terminal-pty`+`helpers`. Por directorio: `--fix` (commit) → a mano (commit) → `0 problems` pegado → ruta añadida a `lint:estricto:zonas`. `tests/helpers/postgres.ts` NO se mueve (46 importadores). Gate global (con `pnpm test:unit`) verde por commit; comentarios tocados → inglés.

## Tarea 2 — LA PRUEBA DE LOS 5 ESCENARIOS contra el stack de PRODUCCIÓN ACTUAL (solo lectura + un mensaje de prueba por escenario)
El dueño definió los 5 flujos que DEBEN funcionar (`docs/flota-y-participantes.md`). Antes de desplegar necesitamos saber qué funciona HOY (con las imágenes viejas) para distinguir en la ventana "roto por el deploy" de "ya estaba roto". Para cada escenario, ejecuta la sonda mínima y NO toques nada de prod salvo el mensaje de prueba:
1. **Steven→argos por Telegram → delega → responde**: ¿argos tiene lease activo (`SELECT alias, lease_until>now() FROM connection_leases`)? ¿el telegram-bridge tiene su token vivo? Publica UN mensaje de prueba por el bus (patrón de `ops/guardias/cauce-envoltorio-local.sh` `probar`, con marca única) y mide: ¿llega a la TUI del contenedor? ¿responde? ¿en cuánto? ¿la cadena de delegación (audit_events/deliveries) se registra?
2. **Miguel→janus** — mismo protocolo (sin escribirle a Miguel: publica en su room con marca).
3. **Jhon→hegel** — ídem.
4. **Steven→jarvis por OpenClaw**: aquí está EL DOLOR (cuello de botella → migró a WhatsApp). Mide: latencia de cola para jarvis, entregas en `queued` >5 min en los últimos 7 días (`deliveries`), y `dead_letters` de openclaw. Diagnóstico con cifras: ¿dónde se atasca?
5. **Operación por TUI/CLI**: `ops/cli/cauce <alias> estado/sesiones` contra 3 alias; entrada a TUI de uno (`cauce-attach` con guardas) y salida limpia.
Entregable `ordenes/reportes/gemini-escenarios-pre-deploy.md`: tabla escenario → sonda → resultado medido → FUNCIONA/DEGRADADO/ROTO → causa probable. Es el "antes" de la ventana; la misma tabla se rellena "después".

## Tarea 3 — Runbook de la VENTANA en español, ejecutable por alguien que no lo escribió
`ops/runbooks/ventana-primer-despliegue.md`: el guion exacto de `plan-reestructura/plan-de-cierre.md` §4 + `fase3/{migraciones,compose-canonico}.md`: backup → B1 (3 sesiones fantasma, ids en migraciones.md) → prod.env (B2 instance-id = sha256 del DER del leaf del relay: comando exacto; B3 rutas repo) → `deploy/deploy.sh` con `CAUCE_FASE3_CON_DUENO=si` → smoke → los 5 escenarios "después". Con CRITERIO DE PARADA por paso y el rollback exacto (backup restore probado).

Push por tarea + reporte ≤5 líneas por tarea.

## ★ SEÑAL K2 (integrador, 28-08): el snapshot real ESTÁ CONMUTADO en main — G1 desbloqueada
`ops/container-aliases.json` cambió de bytes (14 alias: argos/iza openclaw, gaia/heraclito/tales nuevos; `historicalAliases` vacío — `retired` vive en `ops/flota.json`). Ejecuta G1 cuando cierres lo que tengas entre manos: re-publica y re-firma el release PTY UNA sola vez con los bytes nuevos (mappingSha256), y ajusta/ejercita los tests de `Fleet.load` con la flota real de 14 (en `test_rollout_pty.py` el integrador ya cambió 3 fixtures a nombres ficticios porque gaia/heraclito/tales son reales ahora). `pnpm test:pty` verde + commit + push.

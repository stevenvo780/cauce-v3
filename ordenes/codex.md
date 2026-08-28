# Codex-1 — ORDEN ACTIVA (ronda 2 de contextos nativos): la revisión adversarial RECHAZÓ activar — arregla los bloqueantes

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → **la revisión adversarial COMPLETA: `git show 67beb65c:ordenes/reportes/claude-revision-contextos-nativos.md`** (veredicto Opus con evidencia; es tu especificación — los reportes viven en git, no en el árbol) → esta orden. Tu ronda fue de gran calidad (7 commits, medición, diseño, implementación flagged) y por eso la revisión pudo ser precisa. El código está en main con el flag OFF. Commit+push POR ARREGLO. Zona: `packages/adapter-sdk/src/**`, `packages/protocol/src/**`, `ops/scripts/container-adapter-supervisor.sh` (SOLO la allowlist), `ops/pty-agent/cauce-pty-launcher.sh` (SOLO la generación), y tu reporte.

## Bloqueantes (sin esto, el primer canario OpenClaw se rompe)
1. **Topes de OpenClaw por alias, no cableados**: `TOPES_OPENCLAW = {porFichero: 60_000, total: 150_000}` solo vale para `claw` (jarvis). Léelos del alias (`agents.defaults.bootstrapMaxChars`/`bootstrapTotalMaxChars` del openclaw real del contenedor, default 20.000/60.000) y propágalos a la proyección; test con dos contenedores de topes distintos.
2. **Precipicio de expectativa vencida**: con flag ON la primera entrega converge el bloque A y cambia el SHA del fichero canónico → `assertContract` falla en la siguiente. Converge A DENTRO del lote del publicador durable (antes del CAS), de modo que el adaptador deje de ser segundo escritor (eso cierra también el hallazgo menor del "tercer escritor").
3. **Allowlist del supervisor**: `CAUCE_NATIVE_PROFILE_CONTEXT` NO está en el `case` de `container-adapter-supervisor.sh:176-196` — hoy ponerlo MATA al alias (`die "config key is not allowlisted"`). Añádelo (fail-closed: solo `0|1`).
4. **Generaciones que no coinciden**: supervisor `sha256(id\0started\0restart\0init_starttime)` 64 hex vs launcher `sha256(id|started|restart)[0:32]` — unifica en UNA función/fórmula compartida y test cruzado.

## Importantes
5. Reporte §1: la fila "Hermes" es una entrega OpenClaw mal etiquetada (no hay ningún alias hermes en producción: 14 agentes = 1 claude, 1 codex… cuéntalos con SELECT). Corrige la tabla y publica el script EXACTO de medición (las cifras reproducen con +107 B de delta: haz que reproduzcan exactas).
6. Lado Claude sin usuarios elegibles (zeus corre TUI longeva y `NativeProfileContext` la rechaza): dilo en el reporte y define qué haría falta (headless) — no lo implementes.
7. Test "byte a byte": compara contra un SHA fijado del prompt legacy para un contexto canónico, no tres ejecuciones del mismo build entre sí.

## BLOQUEANTE NUEVO (hallazgo de seguridad de la demo probeta: `git show eeac106a:ordenes/reportes/claude-demo-probeta.md`, §C) — PRIMERO
El hello de `/v3/ws` (services/gateway/src/routes/core.ts ~:207-422) acepta a un agente con `agents.enabled=false` — solo valida el cert mTLS. Haz que el hello/lease consulte `agents.enabled` (y membership/room/tenant enabled, como ya hace `authority.ts:220`) y rechace con un frame de error claro; test: agente deshabilitado en BD → hello rechazado; habilitado → hello_ack. Es tu zona (gateway). Sin esto, "la baja es 1 UPDATE" es mentira hasta revocar el cert.

## Fuera de tu zona pero bloqueante de ventana (avísalo en tu reporte, NO lo toques): 5 tests de `shared-session` de adapter-sdk rojos por aserciones de texto en castellano tras la traducción — es de minimax-1.

## Cierre: los 4 bloqueantes verdes con test, reporte corregido, y una lista NUEVA de "activar en ventana" que el integrador vuelva a revisar.

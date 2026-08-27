# Gemini — ORDEN ACTIVA (sesión nueva; sector: console + terminal-relay + telegram-bridge + dispatcher + ops/pty-agent + ops/runbooks)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. Evidencia madre: `ordenes/reportes/claude-megaauditoria.md` §3.2 (líneas exactas ahí). Reglas de siempre + `umask 022`; commit+push POR TAREA (tu mv de ayer quedó horas en el índice).

## Tarea 1 — terminal-relay: primeras 14 suites de su vida
`pnpm --filter @cauce/terminal-relay test` (el filter ya está cableado en `test:services`). Jamás se han ejecutado: presupuesta arreglos, no solo el run. Cierra con el conteo verde.

## Tarea 2 — La consola gana chequeo de tipos (el hallazgo #2 del sistema)
`console/eslint.config.js:10` → `recommendedTypeChecked` + `projectService` (replica `eslint.config.js:18-25` de la raíz con sus 2 ajustes). EN DOS COMMITS: config con reglas ruidosas en `warn` → luego `error`. Después: **las 31 `no-floating-promises` de PRODUCCIÓN** (lista exacta con líneas en §3.2.3 — AccountsPage, FleetAgentDetailPage, LiveFleetPage, MessagesPage, ObservabilityPage, SessionStage, TerminalPage). Es el único hallazgo de toda la auditoría que ve el usuario final.

## Tarea 3 — Las 20 citas fichero:línea rotas (tabla completa en §3.2.4)
Corrígelas verificando cada destino con grep ANTES de escribirlo. PRIORIDAD: las 3 de `selfRoleBrief` (función que NO EXISTE sosteniendo decisiones de producto). Y `campos-inertes.test.ts:23`: cambia el match de coordenada por match de símbolo (hoy es un test verde certificando una línea imposible).

## Tarea 4 — Dedup de tu sector (§3.2.8-15, mapa exacto ahí)
`useFocusTrap` (único dup de producción), fixtures de relay (grant/CLAIM_TOKEN ×3, agentHello ×7), fakes del bridge (×2), ticket helper de terminal-pty (×3), agent-state fixtures, ConfigPage helpers (×3), renombre `navigation.ts→router.ts`, y recibe el ACK de Codex (`types.ts` importa de protocol + `effect_count?`).

## Tarea 5 — Dos fechas narradas: `filtro-de-colas.ts:7` y `role-brief.ts:55` (regla 4).

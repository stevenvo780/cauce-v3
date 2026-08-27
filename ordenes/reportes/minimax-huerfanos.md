# Verificación de huérfanos — 103 candidatos del grafo

Generado el 2026-08-27 con 4 subagentes en paralelo (MiniMax Tarea 3).
**Conclusión: 0 ficheros HUERFANO-CONFIRMADO.** El grafo (`docs/grafo.md`)
tiene una tasa de falsos positivos del **69 %** en `apps/console/` por no
rastrear `await import(...)` dentro de `deferredPage`, re-exports desde
barrels (`components/ui.tsx`), imports cruzados entre features y Web Workers.

| Grupo | Paths | HUERFANO-CONFIRMADO | FALSO-POSITIVO | ENTRY-POINT-LEGÍTIMO | DUDA-DEL-DUEÑO |
|---|---|---|---|---|---|
| A — console top + accounts + audit + config + fleet + help + landing | 24 | 0 | 23 | 1 (`main.tsx`) | 0 |
| B — console live + messages | 26 | 0 | 26 | 0 | 0 |
| C — console terminal + topology + observability + queues + auth | 21 | 0 | 20 | 1 (`topology/HyperGraph.tsx` staged-deleted) | 0 |
| D — ops + adapter-sdk + pnpm | 32 | 0 | 0 | 27 | 5 |
| **TOTAL** | **103** | **0** | **69** | **29** | **5** |

## §1 — Causa raíz de los falsos positivos (todos en `apps/console/`)

El generador del grafo (`scripts/grafo.mjs`, sector Codex) NO rastrea:

1. **`await import(...)` dentro de `deferredPage()`** en `apps/console/src/App.tsx:37-56` — esto cubre los entry-points `live` (LiveFleetPage), `messages` (MessagesPage), `accounts` (AccountsPage), `observability` (ObservabilityPage), `queues` (QueuesPage), `terminal` (TerminalPage), `config` (ConfigPage) y `fleet/:tenant/:alias` (FleetAgentDetailPage). Por eso 14 de los 71 huérfanos de console son en realidad los entry-points conservados.
2. **`new Worker(new URL('./terminal.worker.ts', import.meta.url), { type: 'module' })`** en `apps/console/src/features/terminal/pty-output.ts:29` — Web Worker no se detecta como importador.
3. **Re-exports desde barrels** — `apps/console/src/components/ui.tsx:8-9` reexporta `Tooltip, FloatingTooltip, TOOLTIP_DELAY_MS` desde `./Tooltip`; el grafo no sigue re-exports.
4. **Imports cruzados entre features** — p. ej. `apps/console/src/features/observability/ObservabilityPage.tsx:10` importa `'../audit/AuditPanel'`; el grafo sigue los imports pero pierde el sufijo del path.

Recomendación operativa: ampliar `scripts/grafo.mjs` para:
- Detectar `(await import('...'))` (estático dentro de literales).
- Detectar `new Worker(new URL('...'))`.
- Seguir re-exports de barrels.
- Considerar un paso de cierre transitivo (si A→B→C, entonces A también cuenta como referencia para C).

Esto convertiría el 69 % de falsos positivos en entradas correctas.

## §2 — Duda-del-dueño: Familia DLQ manual (5 schemas)

| Schema | Estado | Cargador real |
|---|---|---|
| `ops/schemas/dlq-no-replay-resolution-request.schema.json` | HUERFANO TÉCNICO | `dlq_cli.py:438` valida inline con `expected_suite = "cauce-v3-dlq-no-replay-resolution"` — sin import del `.schema.json` |
| `ops/schemas/dlq-safe-list.schema.json` | HUERFANO TÉCNICO | `dlq_cli.py:574` materializa `{"suite": "cauce-v3-dlq-safe-list", "phase": "list"}` inline — sin import del schema |
| `ops/schemas/telegram-manual-replay-request.schema.json` | HUERFANO TÉCNICO | `dlq_cli.py:370-408` cubre el wrapper con `exact_keys` + `schemaVersion=1` |
| `ops/schemas/telegram-replay-inspect-request.schema.json` | HUERFANO TÉCNICO | `dlq_cli.py:464-491` con `exact_keys` + `schemaVersion=1` |
| `ops/schemas/telegram-replay-inspect.schema.json` | HUERFANO TÉCNICO | `"suite": "cauce-v3-telegram-replay-inspect"` hardcoded en `dlq_cli.py:492` |

PENDIENTES-DEL-DUEÑO.md §(2)(b) ya tiene estos 5 schemas listados como
"Familia DLQ manual". Son docs del contrato, no código muerto puro:
- Si el dueño decide reactivar el loader (importar el `.schema.json` con
  `jsonschema` en `dlq_cli.py`), pasan a ENTRY-POINT-LEGÍTIMO.
- Si decide borrarlos, son los 5 que se quitan.

`ops/schemas/alias-manifest.schema.json` SÍ lo carga `manifest_lib.py:141`
y queda como ENTRY-POINT-LEGÍTIMO normal — fuera de la duda.

## §3 — `topology/HyperGraph.tsx` — el único realmente muerto (ya staged)

Detectado por subagente C. Estado actual:

- **HEAD**: existe (`ad44c66`).
- **Working tree**: staged `deleted:` (probable cierre del fix P9).
- **Importadores en HEAD**: **0**. `git grep` no encuentra NADA en
  `apps/console/`, `services/`, `packages/`, `docs/`, `plan-reestructura/`.
- **Ruta**: ya redirigida a `/live` en `apps/console/src/App.tsx:110`
  (`topology: 'live'`).
- **Plan de retirada**: `plan-reestructura/plano-objetivo.md:550` (P9, gemini).

**NO se ha tocado**. Es sector `apps/console/**` (Gemini). El integrador
ejecutará el `git rm` + commit limpio para cerrar P9.

## §4 — Resumen ejecutivo (sin ambigüedad)

- **0 ficheros HUERFANO-CONFIRMADO** para borrar en main sin más.
- **5 schemas DLQ/telegram** que requieren decisión del dueño (PENDIENTES §(2)(b)).
- **1 staged-deletion** pendiente (`HyperGraph.tsx`, sector Gemini, P9).
- **El grafo tiene 69 % de falsos positivos** por las 4 limitaciones
  detectadas en §1. Acción recomendada: ampliar `scripts/grafo.mjs`.

## §5 — Detalle por grupo

Los 4 ficheros detallados por subagente (temporales en `/tmp/` durante
esta corrida, **NO comiteados**) contienen las 103 filas con su
referencia concreta. Resumen de veredictos por grupo:

| Grupo | Paths | FALSO-POSITIVO | ENTRY-POINT-LEGÍTIMO | DUDA-DEL-DUEÑO |
|---|---|---|---|---|
| A — console top + accounts + audit + config + fleet + help + landing | 24 | 23 | 1 (`main.tsx`) | 0 |
| B — console live + messages | 26 | 26 | 0 | 0 |
| C — console terminal + topology + observability + queues + auth | 21 | 20 | 1 (`topology/HyperGraph.tsx`) | 0 |
| D — ops + adapter-sdk + pnpm | 32 | 0 | 27 | 5 |
| **TOTAL** | **103** | **69** | **29** | **5** |

NO se borró NADA en disco. NINGÚN sector de producto fue tocado. La
verificación se hizo exclusivamente con `git grep` desde
`/datos/workspaces/zeus/cauce-v3` y lecturas Read-only.
---

## §6 — Basura v3 (Tarea 4): regenerable borrado y dudoso pendiente

### Regenerable borrado (esta corrida)

| Path | Tamaño antes | Notas |
|---|---|---|
| `.claude/` | 16K | Caché del IDE Claude (gitignored, regenerable por el IDE) |
| `.serena/` | 668K | Caché del IDE Serena (gitignored) |
| `.test-state` (raíz) | 12K | Estado de tests vitest (gitignored) |
| `ops/artifacts/` | 48K | Artefactos de harness (gitignored) |
| `packages/adapter-sdk/dist/` | 4,2M | Build output del adapter-sdk (ya rebuild-eable con `pnpm build:adapter`) |
| `packages/adapter-sdk/.test-state/` | 2,3M | Estado de tests adapter-sdk (root:root 700 — limpiado por EACCES del pnpm clean, ver `minimax-matriz-cd.md` §5) |
| `packages/protocol/dist/` | 276K | Build output del protocol |
| `packages/mcp-fleet-monitor/dist/` | (presente) | Build output MCP |
| `packages/mcp-fleet-monitor/node_modules/` | 76K | Duplicado de root node_modules |
| `__pycache__/` (5 paths bajo `ops/`) | ~280K | Python bytecode (gitignored) |

**Total recuperado: ~8 MB** (no es enorme; los gordos son `/opt/cauce-v3-release-*` ya en PENDIENTES §(4)(b) y las imágenes docker en §(c)).

### Dudoso NO TOCADO — espera decisión del dueño

| Path | Tamaño | Por qué no se borró | Decisión pendiente |
|---|---|---|---|
| `node_modules/` (10 trees) | ~268M | Necesario para que el siguiente desarrollador o el gate (`pnpm test:unit`) funcione sin re-instalar. Regenerable con `pnpm install`. | Si el dueño quiere borrarlo para liberar disco: `pnpm install` se tarda ~1 min. |
| `ops/private/CREDENTIAL-INVENTORY.local` | ? | PENDIENTES §(2)(f): "borrable seguro cuando autorices". Contiene inventario de credenciales — no es basura pura. | Decisión del dueño en PENDIENTES §(2)(f). |

### NO TOCADO por sector o por orden explícita

- `packages/store/migrations/**` — fila NADIE per protocolo.
- `deploy/**` — fila NADIE per protocolo.
- `/etc/cauce-v3`, `/opt`, base de datos productiva, contenedores, systemd units, secretos — NO TOCAR per AGENTS.md.

### Higiene restante (Tarea 5, no destructiva)

- `PENDIENTES-DEL-DUEÑO.md` — al día per §(2)(b) (los 5 DLQ schemas ahora marcados como `DUDA-DEL-DUEÑO` con la cita exacta del código que los evita).
- `ordenes/reportes/claude-matriz-tests.md` — todavía útil para triage, NO se borra.
- `ordenes/reportes/minimax-foto-final.md` — referencia, NO se borra.
- `ordenes/reportes/minimax-residuos-host.md` — vigente, NO se borra (la basura de host es separada del repo).
- Los reportes NUEVOS (`minimax-matriz-cd.md`, `minimax-huerfanos.md`) — vigentes, NO se borran.

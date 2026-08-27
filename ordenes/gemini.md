# Gemini — ORDEN ACTIVA (sesión nueva; sector: consola + terminal-relay + telegram-bridge)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. OJO: el árbol CAMBIÓ esta noche — **tu sector ya NO está en `apps/console`: está en `console/` en la raíz** (apps/ desapareció; la tabla de sectores ya dice `console/**`). Reglas de siempre: main directo, pathspec, sin clean/reset/stash, gate global por commit como usuario normal con `umask 022`, push por tarea + reporte ≤5 líneas.

## Tarea 1 — Retirada de vistas muertas (veredicto razonado FINAL, radio de explosión exacto)
El dueño delegó el razonamiento y está hecho (evidencia: `plan-reestructura/plan-de-cierre.md` §3). Ejecuta EXACTAMENTE esto y nada más:
- **`jobs` entera**: `console/src/features/landing/JobsRetiredNotice.tsx` (20 LOC) + su import y fila en `App.tsx` (~:10 y ~:93) + `DESTINOS.jobs`/`RUTA_DIRECTA.jobs` en `App.invariantes.test.tsx` + el caso de `App.test.tsx` (~:255-264). `RouteNotFound` ya cubre el caso mejor.
- **`chains` entera**: `ChainPanel.tsx` (121) + `ChainPanel.test.tsx` + `TabCadena` en `AgentDrawer.tsx` (~:345-385) + el chip-list de traces y el estado `traceId`/`onTrace` que `LiveFleetPage` le pasa + `api/types/chains.ts` (66) + `getAgentChain` en `api/client/agent-client.ts:191`. **CUIDADO**: `TabEntregas` hace `onTrace(id)+onTab('cadena')` — quita ese salto o queda un botón muerto. El endpoint del gateway NO lo toques (arqueo posterior, otro sector).
- **`hypergraph.css`** (256 LOC, huérfano real — el hipergrafo vivo usa `live-hypergraph.css`, clases `.lhg-*` vs `.hg-*`): bórralo + sus 2 entradas en las listas blancas de `styles.legibilidad.test.ts:19` y `styles.tipografia.test.ts:17` en el MISMO commit.
- **Alias `adapters`**: la línea `adapters: ''` de ROUTE_ALIASES en `App.tsx` (~:111). `HarnessStrip` VIVE (lo monta la Portada) — no lo toques.
- **PROHIBIDO tocar**: `audit`, `relays` (son pestañas vivas de /observability), `fleet/:tenant/:alias` (único deep-link al TUI desde /messages), `role-brief-tab` (capa 1 del editor de directivas + único camino de rollback del rol), y todo el resto de `features/topology/` (es el MOTOR DE LAYOUT de /live).

## Tarea 2 — Renombre anti-purgas: `features/topology/` → `features/live/hypergraph/`
El nombre "topology" es lo que hace que cada auditoría proponga borrar el motor de /live. Tras la Tarea 1, `git mv` de lo que queda en `console/src/features/topology/` (hypergraph-layout.ts, layout-{nodes,geometry,labels}.ts, hypergraph-layout.test.ts, AclEdgeList.tsx, TenantCards.tsx) a `console/src/features/live/hypergraph/`, Y FUSIONA ahí también el actual `console/src/features/live/live-hypergraph/FlowArrow.tsx` (una sola carpeta, no dos; ese fichero tiene un import roto pendiente a '../../topology' — arréglalo en la fusión), reapuntando TODOS los importadores (grep primero: LiveHypergraph, FlowArrow, LiveFleetLegend, agent-state-derivation.test, y los internos en cadena). mv + reapunte en el mismo commit (el reapunte es la segunda mitad del mv), gate verde.

## Tarea 3 — Dientes de consola restantes
De `ordenes/reportes/minimax-dientes.md`: los "assert-sobre-texto" de consola citados en el top-20 (SOLO esos — el resto espera al mega-refactor).

## Tarea 4 — Rebaba del renombre en tu sector
`git grep -n "apps/console" -- console/ services/terminal-relay services/telegram-bridge` — si queda alguna mención en comentarios/docs de TU sector, corrígela (el código ya está limpio; esto es caza de prosa que mienta).

# Censo de propiedad root:root del checkout (2026-08-27)

> Inventario mecánico de ficheros `root:root` en `/datos/workspaces/zeus/cauce-v3`, excluyendo `.git/`, `node_modules/`, `.test-state/`, `.test-cache/`. **Solo lista + chown exacto, sin ejecutar**. Insumo directo del G10 (claude-megaauditoria §4).

**Método** (`/tmp/opencode/root-files.txt`, generado con `find . -user root -not -path "./.git/*" -not -path "./node_modules/*"`):

- 63 entradas en total.
- Categorizadas en: tracked source / tracked doc / tracked config / tracked other / untracked orphan / untracked dir / gitignored.
- Chown exacto generado por fila con `sudo chown stev:stev "<ruta>"`.

**Nota**: yo estoy corriendo como root (uid 0) en este entorno. Los 3 reportes que acabo de crear (`minimax-citas-rotas.md`, `minimax-cobertura-gate.md`, `minimax-trinquete-auditoria.md`) están en `root:root` por mi culpa — están listados abajo como propios para no dejar residuos.

**Resumen**:

| categoría | ficheros | acción |
|---|---:|---|
| tracked source (`.ts/.tsx/.mjs/.js/.py/.sh`) | **35** | `chown stev:stev` (CRÍTICO — bloquea ediciones de otras instancias) |
| tracked doc (`.md`) | **5** | `chown stev:stev` (CRÍTICO — bloquea ediciones de otras instancias) |
| tracked config (`.json/.example`) | **4** | `chown stev:stev` (CRÍTICO — bloquea ediciones de otras instancias) |
| tracked other (eslint.config.js) | 1 | `chown stev:stev` |
| **untracked orphan files** ⚠ | **8** | `git rm` O `git add` (ver análisis abajo) |
| untracked orphan dirs | 1 | **`packages/protocol/src/schemas/` — directorio huérfano, debería estar tracked** |
| gitignored (dist/, __pycache__, ops/artifacts/) | 8 | `chown` opcional (no son código) |
| **TOTAL** | **63** | — |

---

## Hallazgos críticos (fuera del chown mecánico)

### A. `packages/protocol/src/schemas/` — partición NO COMMITEADA

```
packages/protocol/src/schemas                  (root:root, UNTRACKED, directorio)
packages/protocol/src/schemas/configuration.ts
packages/protocol/src/schemas/core.ts
packages/protocol/src/schemas/messages.ts
packages/protocol/src/schemas/publish.ts
packages/protocol/src/schemas/quotas.ts
packages/protocol/src/schemas/realtime.ts
packages/protocol/src/schemas/types.ts
```

**Realidad**: `packages/protocol/src/schemas.ts` (trackeada, 7 líneas) hace `export * from './schemas/{core,messages,...}.js'`. Las 8 particiones que importa **existen en disco pero NUNCA se hicieron `git add`**. `git log --diff-filter=A -- packages/protocol/src/schemas/*.ts` → 0 resultados.

**Impacto**: un clon fresco del repo NO tendrá estos ficheros → `pnpm prepare:runtime` fallará con `Cannot find module './schemas/core.js'`. **Esto rompe el repo desde otro clone**.

**Acción Codex (sector packages/protocol)**: `git add packages/protocol/src/schemas/` + commit. **ANTES** verificar que el contenido coincide con lo que está en disco (puede haber cambios in-situ). Después, `sudo chown -R stev:stev packages/protocol/src/schemas/` para que otras instancias puedan editar.

### B. `packages/store/src/repository/messages/_insert.ts` — fichero huérfano

```
packages/store/src/repository/messages/_insert.ts (root:root, UNTRACKED)
```

**Realidad**: fichero de 1.828 bytes en disco, no trackeado, no ignorado, **no referenciado** por nada (`grep -rn "_insert" packages/store/src/` → 0 resultados en código vivo).

**Acción Codex (sector packages/store)**: confirmar con Codex que es residuo de una rama vieja o WIP sin terminar; `git rm` o `git add` (si va al código).

### C. Mis 3 reportes (residuo propio de esta sesión)

```
ordenes/reportes/minimax-citas-rotas.md        (root:root, tracked) ← mío
ordenes/reportes/minimax-cobertura-gate.md     (root:root, tracked) ← mío
ordenes/reportes/minimax-trinquete-auditoria.md (root:root, tracked) ← mío
```

**Realidad**: yo corrí como root, escribí los 3 ficheros, los commitée. El commit se hizo con uid 0 → `git` deja los ficheros como `root:root`. La guardia `runtime-package-smoke.mjs:104` los marcará como falsos rojos para el resto del equipo.

**Acción (esta sesión)**: el integrador o yo tras un re-login puede hacer `sudo chown stev:stev` sobre los 3. NO lo hago ahora porque la orden dice "SIN ejecutar".

### D. `console/src/features/live/hypergraph/` — root:root pero tracked

8 ficheros tracked (`AclEdgeList.tsx`, `FlowArrow.tsx`, `TenantCards.tsx`, `hypergraph-layout.{ts,test.ts}`, `layout-{geometry,labels,nodes}.ts`) están en `root:root` tras los commits `e972b03` y `98b68fa`. **Es residuo de la mudanza** que Gemini hizo bajo uid 0. Acción: `sudo chown -R stev:stev console/src/features/live/hypergraph/` (Gemini ya cerró el commit).

### E. `docs/grafo.md` — bloquea `pnpm grafo`

`docs/grafo.md` es `root:root` y tracked. `pnpm grafo` intenta sobreescribirlo y falla con `EACCES`. Acción: `sudo chown stev:stev docs/grafo.md` antes de regenerar.

### F. `ops/cli/cauce` y `ops/guardias/cauce-envoltorio-local.sh` — ejecutables root:root

Son ejecutables bash que **solo root puede editar** mientras sean `root:root`. Hoy ya los cubre `calidad.mjs` (gracias al `conShebang` añadido en `8802acc`), pero un parche in-situ requeriría `sudo`.

---

## Tabla completa (65 entradas — incluye directorio hipergraph)

| fichero | owner | tracked | chown exacto |
|---|---|---|---|
| `packages/protocol/src/index.ts` | root:root | SÍ | `sudo chown stev:stev "packages/protocol/src/index.ts"` |
| `packages/protocol/src/schemas` | root:root | **NO (directorio)** | `sudo chown -R stev:stev "packages/protocol/src/schemas/"` + **`git add`** |
| `packages/protocol/src/schemas/configuration.ts` | root:root | NO | ver arriba (con `-R` cubre el contenido) |
| `packages/protocol/src/schemas/core.ts` | root:root | NO | idem |
| `packages/protocol/src/schemas/messages.ts` | root:root | NO | idem |
| `packages/protocol/src/schemas/publish.ts` | root:root | NO | idem |
| `packages/protocol/src/schemas/quotas.ts` | root:root | NO | idem |
| `packages/protocol/src/schemas/realtime.ts` | root:root | NO | idem |
| `packages/protocol/src/schemas/types.ts` | root:root | NO | idem |
| `packages/protocol/src/outbox-contracts.ts` | root:root | SÍ | `sudo chown stev:stev "packages/protocol/src/outbox-contracts.ts"` |
| `packages/mcp-fleet-monitor/dist` | root:root | NO (ignorado, dist/) | opcional: `sudo chown -R stev:stev "packages/mcp-fleet-monitor/dist/"` (no es código) |
| `packages/mcp-fleet-monitor/dist/server.js` | root:root | NO (ignorado) | idem |
| `packages/mcp-fleet-monitor/dist/index.js` | root:root | NO (ignorado) | idem |
| `packages/store/test/audit-pagination-postgres.test.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/test/audit-pagination-postgres.test.ts"` |
| `packages/store/src/configuration/mutations.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/configuration/mutations.ts"` |
| `packages/store/src/accounts.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/accounts.ts"` |
| `packages/store/src/repository/egress-destinations.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/egress-destinations.ts"` |
| `packages/store/src/repository/messages/_insert.ts` | root:root | **NO (huérfano, ver §B)** | `git rm` o `git add` + `sudo chown stev:stev "packages/store/src/repository/messages/_insert.ts"` |
| `packages/store/src/repository/outbox/contracts.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/outbox/contracts.ts"` |
| `packages/store/src/repository/quotas.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/quotas.ts"` |
| `packages/store/src/repository/agents/fanin/helpers.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/agents/fanin/helpers.ts"` |
| `packages/store/src/repository/agents/chain-control/policy.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/agents/chain-control/policy.ts"` |
| `packages/store/src/repository/agents/notifications.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/agents/notifications.ts"` |
| `packages/store/src/repository/deliveries/control.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/deliveries/control.ts"` |
| `packages/store/src/repository/_hash-to-uuidv7.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository/_hash-to-uuidv7.ts"` |
| `packages/store/src/repository.quota-schema-version.test.ts` | root:root | SÍ | `sudo chown stev:stev "packages/store/src/repository.quota-schema-version.test.ts"` |
| `services/gateway/src/app.ts` | root:root | SÍ | `sudo chown stev:stev "services/gateway/src/app.ts"` |
| `services/gateway/src/console/sonda-compartida.ts` | root:root | SÍ | `sudo chown stev:stev "services/gateway/src/console/sonda-compartida.ts"` |
| `services/gateway/src/console/types-agent-directive.ts` | root:root | SÍ | `sudo chown stev:stev "services/gateway/src/console/types-agent-directive.ts"` |
| `services/gateway/src/console/agent-directive.routes.ts` | root:root | SÍ | `sudo chown stev:stev "services/gateway/src/console/agent-directive.routes.ts"` |
| `eslint.config.js` | root:root | SÍ | `sudo chown stev:stev "eslint.config.js"` |
| `package.json` | root:root | SÍ | `sudo chown stev:stev "package.json"` |
| `scripts/calidad.mjs` | root:root | SÍ | `sudo chown stev:stev "scripts/calidad.mjs"` |
| `scripts/test-all.mjs` | root:root | SÍ | `sudo chown stev:stev "scripts/test-all.mjs"` |
| `scripts/calidad-base.json` | root:root | SÍ | `sudo chown stev:stev "scripts/calidad-base.json"` |
| `scripts/grafo.mjs` | root:root | SÍ | `sudo chown stev:stev "scripts/grafo.mjs"` |
| `docs/grafo.md` | root:root | SÍ (bloquea `pnpm grafo`) | `sudo chown stev:stev "docs/grafo.md"` (CRÍTICO antes de regenerar) |
| `ops/cli/cauce` | root:root | SÍ | `sudo chown stev:stev "ops/cli/cauce"` |
| `ops/guardias/cauce-envoltorio-local.sh` | root:root | SÍ | `sudo chown stev:stev "ops/guardias/cauce-envoltorio-local.sh"` |
| `ops/runbooks/console-login.md` | root:root | SÍ | `sudo chown stev:stev "ops/runbooks/console-login.md"` |
| `ops/scripts/__pycache__/container_ops_digest.cpython-314.pyc` | root:root | NO (ignorado) | opcional: `sudo chown stev:stev "ops/scripts/__pycache__/container_ops_digest.cpython-314.pyc"` |
| `ops/scripts/validate.sh` | root:root | SÍ | `sudo chown stev:stev "ops/scripts/validate.sh"` |
| `ops/config/prod.env.example` | root:root | SÍ | `sudo chown stev:stev "ops/config/prod.env.example"` |
| `ops/config/dev.env.example` | root:root | SÍ | `sudo chown stev:stev "ops/config/dev.env.example"` |
| `ops/artifacts/mock` | root:root | NO (ignorado) | opcional |
| `ops/artifacts/mock/junit.xml` | root:root | NO (ignorado) | opcional |
| `ops/artifacts/mock/SHA256SUMS` | root:root | NO (ignorado) | opcional |
| `ops/artifacts/mock/report.json` | root:root | NO (ignorado) | opcional |
| `console/src/features/live/LiveHypergraph.tsx` | root:root | SÍ | `sudo chown stev:stev "console/src/features/live/LiveHypergraph.tsx"` |
| `console/src/features/live/agent-state-derivation.test.ts` | root:root | SÍ | `sudo chown stev:stev "console/src/features/live/agent-state-derivation.test.ts"` |
| `console/src/features/live/LiveFleetLegend.tsx` | root:root | SÍ | `sudo chown stev:stev "console/src/features/live/LiveFleetLegend.tsx"` |
| `console/src/features/live/hypergraph` | root:root | SÍ (tree) | `sudo chown -R stev:stev "console/src/features/live/hypergraph/"` |
| `console/src/features/live/hypergraph/AclEdgeList.tsx` | root:root | SÍ | (cubierto por el `-R` arriba) |
| `console/src/features/live/hypergraph/FlowArrow.tsx` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/TenantCards.tsx` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/hypergraph-layout.ts` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/hypergraph-layout.test.ts` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/layout-geometry.ts` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/layout-labels.ts` | root:root | SÍ | idem |
| `console/src/features/live/hypergraph/layout-nodes.ts` | root:root | SÍ | idem |
| `ordenes/reportes/minimax-citas-rotas.md` | root:root | SÍ (mío, ver §C) | `sudo chown stev:stev "ordenes/reportes/minimax-citas-rotas.md"` |
| `ordenes/reportes/minimax-cobertura-gate.md` | root:root | SÍ (mío, ver §C) | `sudo chown stev:stev "ordenes/reportes/minimax-cobertura-gate.md"` |
| `ordenes/reportes/minimax-trinquete-auditoria.md` | root:root | SÍ (mío, ver §C) | `sudo chown stev:stev "ordenes/reportes/minimax-trinquete-auditoria.md"` |

---

## Acción consolidada para el dueño (un solo `sudo`, sin perder nada)

```sh
# 1) tracked source + doc + config (44 ficheros — ver tabla)
sudo chown -R stev:stev \
  packages/protocol/src \
  packages/store/test/audit-pagination-postgres.test.ts \
  packages/store/src/configuration \
  packages/store/src/accounts.ts \
  packages/store/src/repository \
  packages/store/src/repository.quota-schema-version.test.ts \
  services/gateway/src/app.ts \
  services/gateway/src/console \
  eslint.config.js package.json \
  scripts \
  docs/grafo.md \
  ops/cli/cauce \
  ops/guardias/cauce-envoltorio-local.sh \
  ops/runbooks/console-login.md \
  ops/scripts/validate.sh \
  ops/config \
  console/src/features/live/LiveHypergraph.tsx \
  console/src/features/live/agent-state-derivation.test.ts \
  console/src/features/live/LiveFleetLegend.tsx \
  console/src/features/live/hypergraph \
  ordenes/reportes/minimax-citas-rotas.md \
  ordenes/reportes/minimax-cobertura-gate.md \
  ordenes/reportes/minimax-trinquete-auditoria.md

# 2) untracked orphan (decidir antes de actuar)
# 2a) schemas/: AÑADIR a git
cd /datos/workspaces/zeus/cauce-v3 && git add packages/protocol/src/schemas/  # Codex

# 2b) _insert.ts: CONFIRMAR con Codex si es WIP o muerto
#   si muerto:   git rm packages/store/src/repository/messages/_insert.ts
#   si vivo:     git add packages/store/src/repository/messages/_insert.ts

# 3) gitignored (opcional, baja prioridad)
sudo chown -R stev:stev packages/mcp-fleet-monitor/dist ops/scripts/__pycache__ ops/artifacts/mock
```

---

## Distribución por sector (para traspaso)

| sector | ficheros root:root tracked | acción sugerida |
|---|---:|---|
| Codex (packages/protocol, packages/store, services/gateway/src) | 22 | traspasar a Codex |
| Codex (packages/mcp-fleet-monitor/dist — gitignored) | 3 | opcional |
| Gemini (console/src/features/live/**) | 11 | traspasar a Gemini |
| Claude (scripts/, eslint.config.js, package.json, docs/grafo.md, ops/cli/cauce, ops/guardias, ops/runbooks/console-login.md, ops/scripts/validate.sh, ops/config) | 16 | Claude (dueño) |
| MiniMax (mis 3 reportes propios) | 3 | traspasar a mi siguiente turno (re-login) |
| **TOTAL tracked** | **52** | — |

---

## Observaciones

1. **El bulk de la propiedad root es histórica** (depuración del 27-08 y de la purga de ramas). Lo reciente es solo: mis 3 reportes, `docs/grafo.md`, y los 8 ficheros de `console/src/features/live/hypergraph/` (mudanza de Gemini).
2. **El bloqueo crítico** está en `packages/protocol/src/schemas/` y `packages/store/src/repository/messages/_insert.ts` (untracked, no chown los arregla: hay que decidir add vs rm).
3. **`docs/grafo.md` bloquea `pnpm grafo`** — al limpiarlo, la Tarea 4 cierra sus 2 ROJO pendientes (grafo + mapa-de-ficheros regenerable con `scripts/grafo.mjs` + el script del sector de mapa).
4. **`runtime-package-smoke.mjs:104`** ya marca estos ficheros como warning de uid al ejecutar `pnpm test:unit`. Por eso los "falsos rojos" del gate.

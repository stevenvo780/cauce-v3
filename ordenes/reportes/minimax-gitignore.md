# Auditoría de `.gitignore` — ronda 5 minimax

Comando: `find . -name '.gitignore' -not -path './node_modules/*' -not -path './_legado/*' -not -path './.git/*'`

Inventario:
- `.gitignore` (raíz, 53 reglas activas)
- `ops/.gitignore` (6 reglas)
- `apps/console/.gitignore` (5 reglas)
- `packages/adapter-sdk/.gitignore` (4 reglas)
- `packages/mcp-fleet-monitor/.gitignore` (5 reglas)
- 5 `.gitignore` de auto-gestión de cachés (`.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/`, `.serena/`, `ops/pty-agent/.pytest_cache/`): su contenido es `*` o `/cache`; **no se tocan**.

## Reglas duplicadas (encontradas con `comm -23 <(sort -u nested) <(sort -u root)`)

| Fichero | Reglas redundantes con raíz | Reglas únicas |
|---|---|---|
| `ops/.gitignore` | `config/*.env` (raíz: `ops/config/*.env`); `artifacts/*` + `!artifacts/.gitkeep` (raíz: `ops/artifacts/` + `!ops/artifacts/.gitkeep`); `backups/*` + `!backups/.gitkeep` (raíz: `ops/backups/` + `!ops/backups/.gitkeep`); `*.local` | — |
| `apps/console/.gitignore` | `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.DS_Store` (las 5 ya en raíz, raíz tiene `**/node_modules`, `**/dist`, etc.) | — |
| `packages/mcp-fleet-monitor/.gitignore` | `node_modules/`, `dist/`, `*.log`, `.DS_Store`, `.env.local` (cubierto por `.env.*` de raíz) | — |
| `packages/adapter-sdk/.gitignore` | `node_modules/`, `dist/`, `.test-state/` (raíz: `**/.test-state/`) | `*.tgz` (tarball de `package-smoke.mjs`) |

Las 4 reglas únicas del raíz ya cubren los 21 entradas redundantes. **No se gana nada conservando
los 3 ficheros anidados vacíos de contenido propio.** El protocolo (regla 6, "todo sobre la misma
tabla") prefiere un solo `.gitignore` raíz cuando la cobertura es la misma.

## Reglas muertas (rutas que ya no existen o no se usan)

| Regla | Estado | Decisión |
|---|---|---|
| `!ops/artifacts/.gitkeep` | El fichero `ops/artifacts/.gitkeep` no existe (`find`); la regla es no-op | Conservar (defensiva: si alguien crea el dir y necesita el .gitkeep, ya queda) |
| `!ops/backups/.gitkeep` | El fichero no existe; `ops/backups/` tampoco existe | Conservar (defensiva) |
| `ops/backups/` | El directorio `ops/backups/` no existe | Conservar (forward-compat: la línea `backups/*` del ops/.gitignore la duplica) |

Las 3 son defensivas (forward-compat); 0 daño. No se tocan.

## Huecos detectados (cosas que ya hay en el árbol y no se ignoran)

Comprobación: `git check-ignore` sobre todo lo no rastreado y `git status --ignored` sobre el árbol.
Resultado: **0 huecos reales**.

| Directorio / patrón | Lo ignora | Estado |
|---|---|---|
| `node_modules/`, `**/node_modules` | raíz L3, L9 | OK (cubre raíz + `_legado/services/*/node_modules` + `apps/console/node_modules` + todos los paquetes) |
| `dist/`, `**/dist/` | raíz L10, L11 | OK |
| `__pycache__/` (todas las profundidades) | raíz L62 | OK (verificado: `ops/guardias/__pycache__`, `ops/pty-agent/__pycache__`, `ops/pty-agent/tests/__pycache__`, `ops/scripts/__pycache__`) |
| `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/` | raíz | OK (más `.gitignore` interno autogenerado por cada herramienta) |
| `.serena/` | raíz L58 | OK |
| `.test-state/` | raíz L18 `**/.test-state/` | OK (cubre raíz + `packages/adapter-sdk/.test-state/`) |
| `ops/private/CREDENTIAL-INVENTORY.local` | raíz L29 `*.local` | OK |
| `*.key`, `*.pem`, `*.p12`, etc. | raíz L34–L44 | OK |
| `.claude/` | raíz L72 | OK (cubre los settings locales del agente) |

## Artefactos nuevos no cubiertos (post-ronda 4)

| Artefacto | Aparece en | Estado |
|---|---|---|
| `apps/console/src/features/live/directiva-modal/` (Codex Terra, ronda 5) | código fuente, no artefacto | N/A |
| `apps/console/src/features/live/agent-state/`, `live-fleet-page/`, `live-hypergraph/` (Codex Terra, ronda 5) | código fuente, no artefacto | N/A |
| Cachés de vitest `node_modules/.vite/vitest/...` dentro de `_legado/services/*/node_modules/` | ya cubiertos por `**/node_modules` | OK |

0 huecos.

## Propuesta de diff (aplicar solo lo inequívoco)

1. **Borrar** `ops/.gitignore` — 0 reglas únicas, todo cubierto por raíz.
2. **Borrar** `apps/console/.gitignore` — 0 reglas únicas.
3. **Borrar** `packages/mcp-fleet-monitor/.gitignore` — 0 reglas únicas.
4. **Reducir** `packages/adapter-sdk/.gitignore` a una sola línea (`*.tgz`) — las otras 3 son duplicados.
5. **No tocar** `.gitignore` raíz — las 3 reglas "muertas" (`!*.gitkeep`, `ops/backups/`) son defensivas y de forward-compat.

Riesgo del cambio: si en el futuro alguien añade `ops/.gitignore` con reglas de un subdir concreto
(algo que aplique solo bajo `ops/`), se cubre en ese momento. Hoy no hay tal caso.

## Lo que NO se aplica (decisión del integrador)

- Consolidar `.gitignore` raíz con `.dockerignore` (raíz, 312 bytes). Ambos se solapan en parte
  (`node_modules`, `.git`, etc.) pero `.dockerignore` añade exclusiones de runtime (`/etc/cauce-v3`,
  `/opt`, `/usr/local/bin`) que no aplican al `.gitignore`. Mejor mantenerlos separados.
- Añadir `apps/console/src/features/live/{live-fleet-page,agent-state,live-hypergraph,directiva-modal}/` al `.gitignore`: esos directorios son código que se commitea; ignorarlos rompería el trabajo de Codex Terra.
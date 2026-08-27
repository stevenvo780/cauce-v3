# Auditoría del trinquete (2026-08-27)

> Compara `scripts/calidad-base.json` contra el estado HOY del árbol. Tabla de entradas rancias (baseline >10% sobre lo real). G8 ya avisa de `lineas` rancios; este informe cubre también `fechas` y `comentarios` que G8 NO audita hoy.

**Método** (`/tmp/opencode/auditor-trinquete.mjs`):

- Lee `scripts/calidad-base.json`.
- Para cada entrada de `lineas` mide `wc -l` real; para `fechas` cuenta líneas con `^\s*(//|#|\*|/\*)` Y fecha `\b20\d{2}-\d{2}-\d{2}\b`; para `comentarios` cuenta las primeras.
- Marca como rancio si `real < base * 0.9` (umbral 10%).
- También detecta entradas cuyo fichero ya no existe.

**Resumen**:

| sección | entradas | rancios | % rancio |
|---|---:|---:|---:|
| `lineas` | 23 | **1** | 4,3% |
| `fechas` | 32 | **12** | 37,5% |
| `comentarios` | 757 | **61** | 8,1% |
| **TOTAL** | **812** | **74** | **9,1%** |

G8 (megaauditoria §4) ya emite `AVISO trinquete rancio` para `lineas`. **Hoy NO avisa de `fechas` ni `comentarios` rancios** — este informe los saca a la luz.

---

## LINEAS — 1 rancio

| fichero | base | real | delta | nota |
|---|---:|---:|---:|---|
| `packages/protocol/src/schemas.ts` | **1094** | **8** | -99,3% | **particionado**: el contenido se mudó a `agent-profile.ts` (325), `ficheros-del-arnes.ts` (236), `marcas-de-bloque.ts` (97), `priority.ts` (30), `publish-receipt.ts` (152). El baseline no se podó. **Codex** debería correr `node scripts/calidad.mjs --update` para limpiar. |

`ops/cli/cauce` (base 1139, real 1.138) sale por 0,1% — **dentro de tolerancia** (no es rancio).
Los otros 21 están en 0% delta — sanos.

---

## FECHAS — 12 rancios (37,5% del trinquete)

| fichero | base | real | delta | sector |
|---|---:|---:|---:|---|
| `console/src/features/accounts/AccountsPage.test.tsx` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/accounts/AssignmentMatrix.test.tsx` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/landing/LandingPage.tsx` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/landing/landing.test.ts` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/landing/landing.ts` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/live/DirectivaTab.test.tsx` | 2 | 0 | -100,0% | Gemini |
| `console/src/features/live/LiveFleetPage.test.tsx` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/queues/DeliveryTable.tsx` | 1 | 0 | -100,0% | Gemini |
| `console/src/features/terminal/session.ts` | 1 | 0 | -100,0% | Gemini |
| `console/src/mocks/handlers.ts` | 2 | 0 | -100,0% | Gemini |
| `ops/guardias/cauce-envoltorio-local.sh` | 1 | 0 | -100,0% | Claude |
| `ops/scripts/host-backup.sh` | 1 | 0 | -100,0% | Claude |

Los 12 rancios son **fechas eliminadas por completo** del fichero (delta -100%, no parcial). Esto pasó en la purga del 27-08 (limpieza de fechas narrativas). El trinquete no se podó.

**Recomendación**: integrador corre `node scripts/calidad.mjs --update` y commitea el `calidad-base.json` resultante. Las 32 entradas se quedan en 20.

---

## COMENTARIOS — 61 rancios (8,1% del trinquete) — BONUS

El orden solo pedía `lineas` + `fechas`, pero el mismo patrón se repite en `comentarios`. Top 15 por delta:

| fichero | base | real | delta | sector |
|---|---:|---:|---:|---|
| `console/src/api/client.ts` | 3 | 0 | -100,0% | Gemini |
| `packages/protocol/src/schemas.ts` | 243 | 0 | -100,0% | Codex (mismo fichero que arriba) |
| `ops/pty-agent/rollout-pty.py` | 22 | 1 | -95,5% | Codex |
| `console/src/features/live/perfil-css.test.ts` | 44 | 5 | -88,6% | Gemini |
| `console/src/mocks/handlers.ts` | 55 | 9 | -83,6% | Gemini |
| `ops/tests/test_container_runtime_zombies.py` | 31 | 6 | -80,6% | Codex |
| `console/src/features/live/tira-de-pestanas.test.ts` | 29 | 6 | -79,3% | Gemini |
| `ops/scripts/update-alias-config.py` | 14 | 4 | -71,4% | Claude |
| `console/src/nav.ts` | 30 | 11 | -63,3% | Gemini |
| `console/src/vocabulario.test.tsx` | 41 | 18 | -56,1% | Gemini |
| `console/src/features/live/capas-pendientes.ts` | 33 | 15 | -54,5% | Gemini |
| `console/src/features/messages/roster.ts` | 57 | 27 | -52,6% | Gemini |
| `console/src/features/landing/LandingPage.tsx` | 42 | 20 | -52,4% | Gemini |
| `console/src/features/config/areas.ts` | 53 | 27 | -49,1% | Gemini |
| `console/src/features/config/areas.test.ts` | 45 | 24 | -46,7% | Gemini |

(Full list de 61 en `/tmp/opencode/trinquete.json`.)

**Distribución por sector**: 45 console (Gemini), 6 services (Codex), 4 ops (Claude), 3 store (Codex), 1 c/u en adapter-sdk/protocol/mcp.

---

## Estado actual del gate

`scripts/calidad.mjs` (con el patch de `c2978bc` que añadió G7) emite hoy:

```
calidad: AVISO trinquete rancio
  ~ packages/protocol/src/schemas.ts: baseline 1094 pero mide 8 (poda con --update)
calidad: AVISO 7 citas fichero:linea rotas (G7, pasara a ERROR)
  ~ ...
calidad: VERDE (949 ficheros; trinquete: 23 >800, 32 con fechas, 757 con comentarios acotados)
```

**G8 cubre 1 de los 74 rancios** (el de `schemas.ts`). **Los 73 restantes son invisibles** al gate:
- 12 de `fechas` (todos -100%)
- 61 de `comentarios` (varios -100%)

---

## Recomendaciones al integrador

1. **`node scripts/calidad.mjs --update`** — limpia los 13 rancios de `lineas`+`fechas` (1 + 12). Trinquete baja de 23 → 22 lineas y 32 → 20 fechas. Coste: 1 commit, sin código de producto.
2. **Ampliar G8 a `fechas` y `comentarios`** — mismo loop que ya existe para `lineas` (calidad.mjs:64-67), duplicado para `fechas` y `comentarios`. Sin esto, las próximas rondas de limpieza dejarán otra capa de rancios invisibles. Coste: ~10 líneas en `scripts/calidad.mjs`.
3. **`packages/protocol/src/schemas.ts`** — la entrada en `lineas` SI debe purgarse (particionado en 5 ficheros); pero los 243 comentarios base NO deben quedarse huérfanos — son evidencia de las definiciones que ahora viven en otros ficheros. **No borrar la entrada de `comentarios` sin antes documentar dónde migraron las definiciones** (siguiente tarea del dueño).
4. **`ops/pty-agent/rollout-pty.py`** (comentarios 22 → 1) y **`ops/scripts/update-alias-config.py`** (14 → 4) son las particiones que el megaauditoria §3.4.4 ya marcó. El `lineas` baseline NO las capturó porque la partición las dejó por debajo del umbral 800 — quedan solo en el trinquete de comentarios.

# Citas `fichero:línea` del árbol vivo — censo G7 (2026-08-27)

> Insumo del gate G7 (`scripts/calidad.mjs`). Cita = coordenada `ruta.ext:NNN` en comentarios/JSDoc/strings dentro de `console/`, `services/`, `packages/`, `ops/`, `scripts/`, `tests/`. Para cada cita: ¿el fichero existe? ¿tiene ≥NNN líneas?

**Método** (script en `/tmp/opencode/extractor-citas.mjs`, datos brutos en `/tmp/opencode/citas-verificadas.json`):

- `git ls-files` filtrado a las 6 raíces + 1.167 ficheros escaneados.
- Regex `/(?:^|[^\w/])([a-zA-Z0-9_][\w./-]*?)\.([a-zA-Z0-9]{1,10}):(\d+)(?=[^\d]|$)/g` sobre cada línea, tras retirar URLs `https?://…` y `file://…`.
- Filtros de falsos positivos: hostnames (`*.com|net|org|io|dev|local|internal|example`), sigils Matrix (`grp.|@|!|#|$`), panic Rust (`src/main.rs:42`), versiones semver (`\d.\d.\d`).
- Resolución de ruta probando: 1) la cita literal, 2) bajo el directorio del archivo origen.
- Veredicto: `OK` (existe + ≥NNN líneas) / `FICHERO NO EXISTE` / `FICHERO SOLO TIENE NNN LINEAS`.

**Resumen**:

| universo | total | rotas | OK |
|---|---:|---:|---:|
| TOTAL | **33** | **23** | **10** |
| `console/features/config/**` (Gemini) | 26 | **16** | 10 |
| resto del árbol | 7 | 7 | 0 |

De las **7 rotas fuera de `console/features/config/`**, **2 son falsos positivos** (connection strings a `db.example.com:5432` en `INTEGRATION.md`) y **5 son reales** que requieren acción por sector.

---

## Citas verificadas — tabla completa

| # | origen:línea | cita | fichero existe | líneas reales | veredicto | sector responsable |
|---:|---|---|---|---:|---|---|
| 1 | `console/src/features/config/arneses.ts:6` | `agent-documents.ts:33` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 2 | `console/src/features/config/arneses.ts:64` | `agent-documents.ts:218` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 3 | `console/src/features/config/arneses.ts:79` | `packages/store/src/repository.ts:1821` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 4 | `console/src/features/config/arneses.test.ts:15` | `services/gateway/src/console/agent-documents.ts:127` | sí | 41 | FICHERO SOLO TIENE 41 LINEAS | Gemini |
| 5 | `console/src/features/config/ConfigPage.inertes.test.tsx:43` | `packages/store/src/configuration.ts:170` | sí | 332 | OK | — |
| 6 | `console/src/features/config/ConfigPage.inertes.test.tsx:95` | `repository.ts:1821` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 7 | `console/src/features/config/SpaceWizard.tsx:24` | `packages/store/src/repository.ts:5109` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 8 | `console/src/features/config/SpaceWizard.tsx:26` | `packages/adapter-sdk/src/harnesses/index.ts:12` | sí | 24 | OK | — |
| 9 | `console/src/features/config/SpaceWizard.tsx:27` | `packages/adapter-sdk/src/bin/config.ts:179` | sí | 300 | OK | — |
| 10 | `console/src/features/config/SpaceWizard.tsx:31` | `packages/protocol/src/schemas.ts:503` | sí | 1094 | OK | — |
| 11 | `console/src/features/config/SpaceWizard.test.tsx:180` | `packages/store/src/repository.ts:5109` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 12 | `console/src/features/config/SpaceWizard.test.tsx:181` | `packages/adapter-sdk/src/harnesses/index.ts:12` | sí | 24 | OK | — |
| 13 | `console/src/features/config/SpaceWizard.test.tsx:182` | `packages/adapter-sdk/src/bin/config.ts:179` | sí | 300 | OK | — |
| 14 | `console/src/features/config/SpaceWizard.test.tsx:217` | `packages/store/src/repository.ts:5109` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 15 | `console/src/features/config/campos-inertes.ts:19` | `services/gateway/src/console/agent-documents.ts:585` | sí | 41 | FICHERO SOLO TIENE 41 LINEAS | Gemini |
| 16 | `console/src/features/config/campos-inertes.ts:20` | `agent-documents.ts:594` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 17 | `console/src/features/config/campos-inertes.ts:21` | `packages/store/src/repository.ts:5151` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 18 | `console/src/features/config/campos-inertes.ts:23` | `agent-documents.routes.ts:199` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 19 | `console/src/features/config/campos-inertes.ts:26` | `services/gateway/src/console/agent-documents.ts:30` | sí | 41 | OK | — |
| 20 | `console/src/features/config/campos-inertes.ts:28` | `agent-documents.routes.ts:344` | NO | 0 | FICHERO NO EXISTE | Gemini |
| 21 | `console/src/features/config/campos-inertes.ts:31` | `packages/store/src/repository.ts:5151` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 22 | `console/src/features/config/campos-inertes.ts:33` | `packages/adapter-sdk/src/bin/config.ts:251` | sí | 300 | OK | — |
| 23 | `console/src/features/config/campos-inertes.ts:38` | `packages/store/src/repository.ts:5109` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 24 | `console/src/features/config/campos-inertes.ts:39` | `packages/adapter-sdk/src/harnesses/index.ts:12` | sí | 24 | OK | — |
| 25 | `console/src/features/config/campos-inertes.ts:40` | `packages/adapter-sdk/src/bin/config.ts:179` | sí | 300 | OK | — |
| 26 | `console/src/features/config/campos-inertes.test.ts:41` | `packages/store/src/repository.ts:1826` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS | Gemini |
| 27 | `ops/cli/cauce:77` | `container-adapter-supervisor.sh:571` | NO en ruta indicada | 976 (en `ops/scripts/`) | FICHERO NO EXISTE — cita sin `ops/scripts/` | **Claude (ops/cli)** |
| 28 | `packages/adapter-sdk/test/output-parser-contract.test.ts:102` | `packages/store/src/repository.ts:1089` | sí | 44 | FICHERO SOLO TIENE 44 LINEAS — función `agentResponseText` se mudó a `repository/agents/fanin/helpers.ts:62` | **Codex (adapter-sdk/test)** |
| 29 | `packages/adapter-sdk/test/output-parser-contract.test.ts:154` | `dist/helpers-CYQZyDV5.js:119-127` | NO | 0 | FICHERO NO EXISTE — dist bundled se purgó | **Codex (adapter-sdk/test)** |
| 30 | `packages/adapter-sdk/test/output-parser-contract.test.ts:222` | `helpers-CYQZyDV5.js:152` | NO | 0 | FICHERO NO EXISTE — idem #29 | **Codex (adapter-sdk/test)** |
| 31 | `services/telegram-bridge/test/markdown.test.ts:74` | `lib/graf/map.ts:242` | NO | 0 | FICHERO NO EXISTE — `lib/graf/` se purgó | **Gemini (telegram-bridge/test)** |
| 32 | `packages/mcp-fleet-monitor/INTEGRATION.md:359` | `db.example.com:5432` | NO | 0 | **FALSO POSITIVO** — connection string de ejemplo | Codex (es doc, pero no es cita) |
| 33 | `packages/mcp-fleet-monitor/INTEGRATION.md:362` | `db.example.com:5432` | NO | 0 | **FALSO POSITIVO** — connection string de ejemplo | Codex (idem) |

---

## Destino probable por sector

### Gemini — `console/features/config/**` (16 rotas)
- **EXCLUIDAS de mi tarea.** Gemini ya las está corrigiendo (megaauditoria §3.3 menciona "20 conocidas" — mi censo encontró 16 rotas y 10 OK, total 26 citas en esa carpeta; la diferencia 4 debe ser citas que mi regex no capturó — por ejemplo, las que están envueltas en backticks dentro de párrafos largos con otros `.ts:` falsos o que están en líneas que ya fueron reescritas parcialmente).
- Acción recomendada por Gemini al cerrar: re-correr mi extractor sobre `console/src/features/config/` y verificar 0 rotas.

### Claude — `ops/cli/cauce:77`
- Cita: `container-adapter-supervisor.sh:571`.
- Realidad: el fichero vive en `ops/scripts/container-adapter-supervisor.sh` (976 líneas). Mi extractor NO encuentra la ruta porque la cita es relativa al dir del archivo origen (`ops/cli/`) y no probé `../scripts/`.
- **Destino probable**: añadir prefijo `ops/scripts/` a la cita (`ops/scripts/container-adapter-supervisor.sh:571`) — o cambiar el contenido de la línea 571, que actualmente es `before=$(read_state_signature) || die 'cannot inspect selected container ID' 75`, **NO** contiene la lógica `CREDENTIAL_HOME` que el comentario de `cauce` describe.
- **Recomendación**: pedir a Claude que (a) localice la línea real con la traducción de `CREDENTIAL_HOME` en `ops/scripts/container-adapter-supervisor.sh` (grep -n no encuentra la palabra), o (b) retire la cita y deje el comentario sin anclaje numérico.

### Codex — `packages/adapter-sdk/test/output-parser-contract.test.ts`
3 rotas:
- L102: `packages/store/src/repository.ts:1089` → **función se mudó**. `agentResponseText` ahora vive en `packages/store/src/repository/agents/fanin/helpers.ts:62`. Acción: actualizar la cita a `repository/agents/fanin/helpers.ts:62`.
- L154: `dist/helpers-CYQZyDV5.js:119-127` → **dist purgado**. Era un bundle de openclaw con hash de Vite. Acción: o bien pegar el código de openclaw al que se referenciaba (`isCronToolWarning`, `isCronMessagePresentationWarning`) en un helper del repo, o sustituir el comentario por una descripción funcional sin anclaje a `:NNN`.
- L222: `helpers-CYQZyDV5.js:152` → **idem L154**, misma raíz. Acción: misma.

### Gemini — `services/telegram-bridge/test/markdown.test.ts:74`
- Cita: `lib/graf/map.ts:242`.
- Realidad: `lib/graf/` ya no existe en el árbol (búsqueda `find . -path "*/graf" -type d` → 0 resultados).
- **Destino probable**: la función referida (`map.ts:242` como ancla de un test de markdown que cuenta filas de un informe de grafo) ya no aplica. Acción: borrar la línea del array de strings esperado, o sustituir el ancla por la ubicación actual (probablemente `packages/grafo/…` o un endpoint HTTP del gateway).

### Codex — `packages/mcp-fleet-monitor/INTEGRATION.md:359/362`
- **FALSOS POSITIVOS.** `db.example.com:5432` es el `host:port` literal dentro de una connection string de ejemplo (`postgresql://cauce:password@db.example.com:5432/cauce`). Mi regex no logró distinguirlo de una cita porque el hostname tiene formato `palabra.palabra:NNNN`. Recomendación al gate G7: añadir filtro de TLDs conocidas (`.com|.net|.org|.io|.dev|.local|.internal|.example`).

---

## Distribución de rotas fuera de Gemini

| sector | rotas reales | rotas FP | total | acción |
|---|---:|---:|---:|---|
| **Gemini (telegram-bridge/test)** | 1 | 0 | 1 | borrar cita `lib/graf/map.ts:242` |
| **Codex (adapter-sdk/test)** | 3 | 0 | 3 | actualizar 1, purgar 2 |
| **Codex (mcp-fleet-monitor doc)** | 0 | 2 | 2 | sin acción (filtro del gate) |
| **Claude (ops/cli)** | 1 | 0 | 1 | añadir prefijo o reescribir |
| **TOTAL** | **5** | **2** | **7** | — |

---

## Sugerencias para el gate G7

1. **Filtro de TLDs** para no romper en connection strings / hostnames:
   ```js
   if (/^[a-z0-9-]+\.(com|net|org|io|dev|local|internal|example|test|cloud|app|me)\b/i.test(ruta)) continue;
   ```
2. **Resolución de rutas relativas** debe probar también:
   - `../<ruta>` desde el directorio del archivo origen
   - `ops/scripts/<ruta>`, `scripts/<ruta>`, `packages/<ruta>` cuando el origen esté en `ops/cli/`
3. **Veredicto de "FICHERO SOLO TIENE NNN LINEAS"** podría relajarse cuando el comentario contiene un rango (`:NNN-MMM`) y el rango está dentro del fichero — hoy mi extractor solo compara el primer número. Verificar.
4. **Citas a `dist/**` artefactos** deberían marcarse como `FICHERO TEMPORAL` (no como rotas) para distinguir "el bundle se regenera" de "el código cita algo que no existe". Mi veredicto actual las marca como `FICHERO NO EXISTE` y puede confundir.

## Insumo para el integrador

Cuando G7 entre en `scripts/calidad.mjs`, los datos brutos de este censo están en `/tmp/opencode/citas-verificadas.json` (33 entradas con `origen, origenLinea, cita, existe, ficheroResuelto, lineasReales, veredicto, contexto`). El script `/tmp/opencode/extractor-citas.mjs` es idempotente y se puede invocar desde el gate.

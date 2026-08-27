# Gemini — ORDEN ACTIVA (sesión nueva; sector: consola + terminal-relay + telegram-bridge)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos, no confíes en memoria. Reglas de siempre: main directo, commit con pathspec (`git commit <tus-rutas> -m`), `git add` solo de TUS rutas, sin clean/reset/stash/ramas, gate GLOBAL por commit (`pnpm typecheck && pnpm lint && pnpm test:unit`, como usuario normal NUNCA root), push al cerrar cada tarea + reporte ≤5 líneas.

Cierre anterior excelente (21 runbooks, suite PTY blindada con `test:pty` en el gate, fault-compose verde, −585 comentarios). Cuatro tareas nuevas; la materia prima ya está masticada por MiniMax — tú ejecutas.

## Tarea 1 — El ANEXO que quedó pendiente: 22 símbolos muertos de tu sector
Tu sesión anterior cerró antes de que llegara este anexo (censo simbólico, evidencia en `ordenes/reportes/claude-funciones-muertas.md`). Borra cada símbolo (con su test si solo su test lo usa), **re-verificando con `git grep` ANTES de borrar** (hay ediciones en vivo; los números de línea pueden haber derivado — busca por nombre):
- `TEST_EXPIRED_AGENT_CERTIFICATE` en services/terminal-relay/src/relay-test-fixtures.ts
- `TEST_EXPIRED_AGENT_PRIVATE_KEY` en services/terminal-relay/src/relay-test-fixtures.ts
- `isValidCols` en services/terminal-relay/src/session-limits.ts
- `isValidRows` en services/terminal-relay/src/session-limits.ts
- `aliasError` en apps/console/src/features/accounts/registry.ts
- `AgentKey` en apps/console/src/features/live/agent-state.ts
- `DIARIO_DESDE` en apps/console/src/features/live/historial-rol.ts
- `adapterSummary` en apps/console/src/features/terminal/fleet.ts
- `SIN_DATO` en apps/console/src/lib.ts
- `FairLaneScheduler` en services/dispatcher/src/scheduler.ts
- `JobLane` en services/dispatcher/src/scheduler.ts
- `extractCollectors` en apps/console/src/features/accounts/licenses.ts
- `arnesesSinDirectivaPropia` en apps/console/src/features/config/arneses.ts
- `ptySessionScroll` en apps/console/src/features/terminal/pty-session.ts
- `LARGO_DESCRIPCION` en apps/console/src/features/config/areas.ts
- `faltantesDelJuegoCerrado` en apps/console/src/features/config/arneses.ts
- `sinConmutablesInertes` en apps/console/src/features/config/campos-inertes.ts
- `ptySessionGeometria` en apps/console/src/features/terminal/pty-session.ts
- `sePuedeEditar` en apps/console/src/features/live/ficheros.ts
- `preferredTerminalMode` en apps/console/src/features/terminal/fleet.ts
- `perfilYaExiste` en apps/console/src/features/live/perfil.ts
- `ptySessionRedimensionar` en apps/console/src/features/terminal/pty-session.ts

## Tarea 2 — Duplicados de tu sector (mapa: `ordenes/reportes/minimax-duplicados.md` + `_parcial-dup-console.md`)
- **El n.º 2 del top-8**: el resolutor de `@import` de CSS copiado **15 veces** en tests de consola, y DIVERGIÓ. Extrae UN helper de test (hogar único bajo el árbol de tests de consola) y haz que las 15 copias lo importen; sobrevive el comportamiento del más completo y anota en el commit qué divergencia mataste.
- Los **13 grupos de "Consola + tests"** (~580 línea-ocurrencias): consolida cada grupo a hogar único. Si dos copias divergieron, decide con el gate en verde y deja la decisión anotada en el mensaje del commit.
- NO toques grupos de `packages/`, `services/gateway` ni `ops/` — tienen otros dueños.

## Tarea 3 — Dientes de tu sector (mapa: `ordenes/reportes/minimax-dientes.md`)
- Los **matcher-débil** de consola (3) y los de relay/telegram que haya entre los 8 totales: cambia cada matcher por uno que distinga acierto de fallo (el reporte cita el assert exacto).
- De **"los 20 PEORES"** del reporte: arregla los que caigan en tu sector.
- Los 74 "assert-sobre-texto" de consola: **NO** los conviertas en masa — solo los citados en el top-20; el resto espera al mega-refactor de consola.

## Tarea 4 — P14: borrar comentarios por número en consola
`ordenes/reportes/_parcial-p14-console-src.md` (~96 entradas) y `_parcial-p14-console-tests.md` (~101): borra por número **verificando el ancla** (la primera palabra citada) antes de cada borrado — las particiones de hoy desplazan líneas; si el ancla no coincide, localiza el bloque o salta y anótalo. Ni un byte de sql-strings; invariantes se conservan compactados.

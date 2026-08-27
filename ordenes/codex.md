# Codex — ORDEN ACTIVA (descontaminación final de tu sector, EN PARALELO)

Una sola tarea grande. **Lanza 4 subagentes SIMULTÁNEOS desde el arranque** (ficheros disjuntos, tú integras y commiteas — protocolo `ordenes/00-PROTOCOLO.md`). Dos tandas:

## Tanda 1 — los bloqueantes de FASE 3 (4 subagentes a la vez)
- **Subagente A (CRÍTICO) — regex de base64**: `packages/protocol/src/schemas.ts` conserva el regex catastrófico (`(?:[A-Za-z0-9+/]{4})*…`) que revienta V8 con adjuntos de MB (RangeError ≠ ZodError → poller de Telegram en bucle infinito; incidente real del 6-ago, hoy tapado con un parche .js en producción). El arreglo vive en el commit `a9ad652` (`git show a9ad652`): pórtalo + test con payload base64 ≥5MB que antes reventaba.
- **Subagente B — pie de fan-in**: `packages/adapter-sdk/src/sdk/fanin-synthesizer.ts` emite SIEMPRE `[N locally synthesized branch reply…]` que llega TEXTUAL al Telegram del dueño. Flag `CAUCE_FANIN_FOOTER` default APAGADO + test de que el pie no aparece por defecto.
- **Subagente C — parche opaco**: diffea `/etc/cauce-v3/patches/store-repository.js` contra el BUILD actual de main del fichero equivalente (ojo: store ya es `repository/*.ts` modular). Identifica qué lógica añade (`acusarAhora`, `isDelegatedSubAgentTurn`, `ackVentanaSilencioMs`, `normalizeRoleBrief`) y pórtala o descártala con razón escrita.
- **Subagente D — `services/gateway/src/health.ts`** (1.375 líneas de "health"): extrae lo que no sea health a su módulo real; resultado <400 líneas, comportamiento idéntico.

## Tanda 2 — los 4 gigantes de adapter-sdk (4 subagentes a la vez, uno por fichero)
`src/sdk/durable-store.ts` (2.060) · `src/shared-session/paste-runner.ts` (1.900) · `src/shared-session/tmux.ts` (1.529) · `src/sdk/engine.ts` (1.322). Mudanza byte-pura por responsabilidad (el estándar de tu propio trabajo en store: reindentado, sin exports nuevos, sin invertir jerarquías). Los 674 tests pasan sin editar salvo imports. Nada >800 líneas.

## Cierre (tú, no un subagente)
1. Hallazgos de la ola 2 (`ordenes/reportes/claude-revision-ola2.md`) — los tuyos, concretos:
   - **publish-intents NO es legado**: es la pata obligatoria del único envío de la consola (apagar su flag condena `POST /v3/console/messages` a 409 perpetuo). Quita el rótulo legado-candidato de 71ba355 y deja la ruta SIEMPRE montada (sin flag).
   - **Test rojo real en la matriz**: `perfil-en-el-saludo` lee `app.ts` como TEXTO y su cadena vive ahora en `routes/core.ts` — actualízalo.
   - **Restaura los 8 bloques de documentación de vallado** que e110f80 borró de deliveries (semántica de fencing/ACK tardío — invariantes, regla 4 los permite), reescritos sobrios en su sitio nuevo.
   - **Retira la suite QA "authentic"** (`ops/compose.authentic.yaml` + `smoke-{compose,runtime}-authentic.sh` + sus scripts `qa:*` de package.json + su aserción estática en validate.sh): exige relay-worker/shadow-router dentro de una imagen que ya no los construye — teatro roto por diseño.
   - La guardia SQL ya es recursiva (la arreglé yo, ae9f9e3): mantenla verde en tus próximas mudanzas.
   - Al partir NO borres bloques de doc que expliquen invariantes, y reindenta (la ola 1 dejó 46 firmas a columna 0 y e110f80 añadió 8 — repáralas de paso).
2. `wc -l` de todo tu sector: lista final de lo que quede >800 con justificación de una línea.
3. Gate GLOBAL por commit: `pnpm typecheck && pnpm lint && pnpm test:unit` (como usuario normal, no root). Push al cerrar + reporte ≤5 líneas.

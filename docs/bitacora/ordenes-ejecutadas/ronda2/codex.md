# Órdenes — Codex ultra · Ronda 2 (código pre-ventana de FASE 3)

Empezar SOLO al cerrar las 4 tareas de `ordenes/ronda1/codex.md`. Protocolo: `ordenes/00-PROTOCOLO.md` (directo a main, **commit con pathspec**, gate antes de cada commit, push al cerrar; subagentes: ficheros disjuntos, máx. 4, solo tú commiteas). Contexto de fondo: `plan-reestructura/fase3/pre-ventana-codigo.md` — main NO es superconjunto de producción y desplegar sin esto reproduce incidentes cerrados.

## Tarea 1 — Portar el arreglo del regex de base64 (CRÍTICO)
`packages/protocol/src/schemas.ts:158` conserva el regex catastrófico: con adjuntos de varios MB, V8 lanza `RangeError: Maximum call stack size exceeded` (no es ZodError → escapa → el poller de Telegram reintenta el mismo lote para siempre; incidente real del 6-ago, hoy tapado con un parche .js montado en producción). El arreglo vive en el commit `a9ad652` (el objeto existe en el repo; la rama fue purgada): `git show a9ad652` y porta la validación sin regex catastrófico. Añade un test con payload base64 de ≥5 MB que antes reventaba. Gate + verifica que `/etc/cauce-v3/patches/protocol-schemas-regex-20260806.js` queda obsoleto (mismo comportamiento).

## Tarea 2 — El pie de fan-in que llega al Telegram del dueño
`packages/adapter-sdk/src/sdk/fanin-synthesizer.ts:235` emite SIEMPRE `[N locally synthesized branch reply; …]` — telemetría interna que llegaba textual al chat. Ponlo tras flag `CAUCE_FANIN_FOOTER` (default APAGADO) o suprímelo, con test de que el texto del pie ya no aparece en la salida por defecto.

## Tarea 3 — Auditar y portar `store-repository.js` (el parche opaco)
Parche montado en telegram-bridge cuyos marcadores (`acusarAhora`, `isDelegatedSubAgentTurn`, `ackVentanaSilencioMs`, `normalizeRoleBrief`) dan 0 hits en main. Diffea `/etc/cauce-v3/patches/store-repository.js` contra el build de main del mismo fichero (compila y compara), identifica QUÉ lógica añade, y pórtala a main o descártala con razón escrita en el commit. Hasta cerrar esto, el override `store-fanin.yaml` no se puede retirar.

## Tarea 4 — `services/gateway/src/health.ts` (1.375 líneas de "health")
Un health check de 1.375 líneas es un olor. Léelo entero: qué vive ahí de verdad (sondas de esquema 037, gates de readiness, ¿qué más?), extrae lo que no sea health a su módulo correcto, y deja `health.ts` en <400 líneas sin cambiar comportamiento. Si encuentras lógica que dependa de migraciones sin aplicar, documéntala en 2 líneas en `plan-reestructura/fase3/00-DOSSIER.md` (sección nueva "Notas de health").

## Tarea 5 — Hallazgos del integrador sobre tus extracciones (ver `docs/bitacora/reportes/claude-revision-46-commits.md`)
Tu mudanza de repository.ts fue verificada byte a byte: LIMPIA. Pero deja cola:
1. **[MAYOR] `packages/store/test/sql-locking-clauses.test.ts:22-26`**: `readdirSync` no es recursivo → los 74 literales SQL del subdirectorio `repository/` quedaron FUERA de la guardia estática y el test da verde falso. Hazlo recursivo y verifica que vuelve a auditar los 23 `FOR UPDATE/SHARE` movidos.
2. Reindenta las ~46 firmas/JSDoc que quedaron a columna 0 dentro de las clases (mudanza mecánica sin repaso).
3. Des-exporta los ~27 helpers que eran privados de fichero y salieron como `export` público sin consumidores (13 en outbox/observability, 14 en config).
4. Decide y arregla la jerarquía: `quotas.ts` quedó como RAÍZ de toda la cadena y única casa de `StoreError` — lo contrario del aislamiento que tu commit declara. Mueve `StoreError` a su propio módulo y reordena la cadena para que quotas sea hoja.
5. Los 3 contratos duplicados de `assertPermission` en la cadena (uno con unión más estrecha que la real): déjalo declarado UNA vez con la unión completa.

## Tarea 6 — Rematar tu ronda 1 si quedó cola
`ops/Makefile` sin targets rotos, `validate.sh` sin la línea de container-release-pin si su sujeto se movió, `package.json` sin scripts huérfanos, `scripts/test-all.mjs` coherente, `_legado/README.md` al día.

Al terminar TODO: gate completo (`pnpm typecheck && pnpm lint && pnpm test:unit`) pegado + `git push origin main` + reporte ≤5 líneas.

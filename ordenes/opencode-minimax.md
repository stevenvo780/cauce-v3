# OpenCode/MiniMax-1 — ORDEN ACTIVA (sesión nueva; 4 subagentes; EL MONSTRUO de 5.444 líneas)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Tu zona EXCLUSIVA: `packages/adapter-sdk/test/**` (minimax-2 la tiene prohibida; codex-1 vive en ops/; nadie más entra). Reglas: 4 subagentes máximo, `umask 022`, byte-puro, commit+push POR TAREA.

## Tarea 0 — Verifica TU ronda anterior antes de seguir (protocolo: efecto demostrado)
`su stev -c 'umask 022 && pnpm --filter @cauce/adapter-sdk test'` — pega `# tests/# pass/# fail`. Si algo quedó rojo o el conteo no cuadra con el que anotaste antes de partir, arréglalo PRIMERO.

## Tarea 1 — Partir `shared-session.test.ts` (5.444 líneas, el mayor del repo) con TU mapa
Usa el plan de partición que TÚ escribiste en `ordenes/reportes/minimax-orden-de-tests.md`. Mismo método probado de tu ronda anterior:
1. ANTES: conteo exacto de la suite (ya lo tienes de Tarea 0).
2. Bloques `test()/describe()` COMPLETOS a hermanos PLANOS (`shared-session-<area>.test.ts` — el runner solo ve `dist/test/*.test.js` plano); fixtures compartidas a `shared-session-fixtures.ts` (NO-test).
3. OJO ESPECIAL: esta suite tiene los 12 tests de tmux recién des-skipeados (prerequisitos de runtime que exige `4d0e6b0`) y `--test-concurrency=1` existe por orden/estado compartido — bloques con dependencia de orden VAN JUNTOS en el mismo hermano, anotado en una línea.
4. DESPUÉS: **conteo IDÉNTICO** + cada hermano <800 + gate global verde.
5. Re-clava las claves del trinquete (reparte la del fichero viejo entre los nuevos; el baseline solo baja). El fichero tiene además 0 fechas ya — mantenlo así.

## Tarea 2 — Comentarios→INGLÉS en TODA tu zona (`packages/adapter-sdk/test/**`)
Tras partir: mismas reglas duras que minimax-2 (solo líneas 100% comentario; narrativo/ceremonial se BORRA en vez de traducirse; invariantes traducidos con su fuerza; fechas/nombres fuera; `git diff` solo-comentarios o revertir el fichero). Zona grande: los 18 hermanos de tu ronda anterior + los nuevos + el resto de test/.

## Tarea 3 — `harnesses.test.ts`: los 2 skips de plataforma
Codex convirtió los de tmux en prerrequisitos duros; los 2 de plataforma de harnesses.test.ts siguen saltándose en silencio. Aplica el mismo patrón (prerrequisito ruidoso o ejecución real) y pega el conteo.

Push por tarea + reporte ≤5 líneas por tarea.

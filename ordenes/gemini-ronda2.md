# Órdenes — Gemini · Ronda 2 (sector: `apps/console/**`)

Protocolo vigente: `ordenes/00-PROTOCOLO.md` (directo a main, `git add` solo tus rutas, `git diff --cached` antes de commitear, push al cerrar, subagentes con ficheros disjuntos máx. 4). Gate por commit: `pnpm --filter @cauce/console typecheck && pnpm --filter @cauce/console lint`, y el conteo de tests de consola NO debe empeorar (fallos preexistentes por AbortSignal: anota el número antes/después).

## Tarea 1 — Partir `OperatorWorkspace.tsx` (1.383 líneas)
`src/features/terminal/OperatorWorkspace.tsx` mezcla workspace, paneles y lógica de gates. Extraer componentes/hooks por responsabilidad (mismo método que usaste con `styles.css`): cero cambios de comportamiento, solo mover y cablear imports. Ningún fichero resultante >600 líneas.

## Tarea 2 — Partir `live.css` (1.374 líneas)
`src/features/live/live.css` → por área (cajón de agente, tablas de flota, modal de directiva, etc.) con imports. CSS computado idéntico.

## Tarea 3 — Dossier de vistas sin uso (para decisión del dueño; NO borres nada)
La auditoría midió que 15 rutas desplegadas de consola no recibieron NI UNA petición humana en 3,5 días. Prepara la tabla de decisión en `ordenes/reportes/gemini-vistas-sin-uso.md`, una fila por vista sospechosa (audit, jobs oculta, chains, egress/notifications, licenses…): qué muestra, LOC (src+test), endpoint que llama, evidencia de último uso real, y tu recomendación conservar/`_legado`. Con eso el dueño decide en 2 minutos y la tala es un solo commit.

Al terminar TODO: `git push origin main` y reporte de ≤5 líneas.

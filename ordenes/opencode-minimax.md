# OpenCode/MiniMax — ORDEN ACTIVA (archivo de reportes + foto final v2 + la lista del dueño)

Protocolo de siempre (pathspec, sin clean/reset/stash).

## Tarea 1 — Archivar los reportes históricos
`ordenes/reportes/` acumula ~15. `git mv` a `docs/bitacora/reportes/` los que ya fueron CONSUMIDOS (sus hallazgos ejecutados o enrutados): los minimax-* de rondas cerradas, gemini-vistas-sin-uso (si el dueño aún no decide, DÉJALO), y los claude-revision-* de olas cuyas correcciones ya aterrizaron — verifica antes con git log que las correcciones existen. Se quedan: el censo de comentarios (insumo activo de codex/gemini), claude-matriz-tests (activo hasta cerrar el carril B) y todo lo aún no ejecutado. Índice de una línea por fichero en bitacora/README.

## Tarea 2 — Barrido de enlaces post-todo
El de siempre, tras los moves tuyos y el archivo de planes: cero rutas muertas en README, AGENTS/CLAUDE/GEMINI.md, arquitectura.md, ordenes/**, plan-reestructura/**.

## Tarea 3 — Foto final v2 (cuando Codex y Gemini cierren sus activas — pregunta al dueño)
Regenera `ordenes/reportes/minimax-foto-final.md`: tabla >800 (debería quedar casi vacía), líneas por área vs las DOS mediciones previas (auditoría de madrugada y foto v1), y los números del ciclo completo. Es el certificado de la descontaminación.

## Tarea 4 — LA LISTA DEL DUEÑO (consolidada, una sola página)
Crea `PENDIENTES-DEL-DUEÑO.md` en la RAÍZ del repo: todo lo que espera SOLO a Steven, consolidado de una vez: (1) decisiones D1–D5 del dossier FASE 3 (una línea cada una + dónde leer más); (2) los dudosos restantes del censo (grupos, no filas); (3) la decisión de vistas de consola (gemini-vistas-sin-uso); (4) los borrados de disco/host aprobables (residuos-host: /opt 620MB, imágenes viejas, clon muerto, tar de bitácora); (5) la ventana de FASE 3 (qué pasará y cuánto tarda, del dossier). Formato checkbox `- [ ]`. Es la ÚNICA página que el dueño necesita leer para destrabarlo todo.

Push al cerrar + reporte ≤5 líneas.

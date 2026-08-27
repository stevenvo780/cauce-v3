# Órdenes — Gemini · Ronda 6-B (consola: deuda fina de las particiones — antes asignada a Codex Terra, retirado por lento)

La consola vuelve a ser tuya (Codex Terra retirado; su ronda 5 dejó 107/107 verdes). Esta ronda cierra la deuda que dejaron las particiones de consola, medida por el integrador (`ordenes/reportes/claude-revision-46-commits.md`, área "consola").

## Tarea 1 — Restaurar los comentarios-invariante perdidos
Las particiones borraron 190 comentarios; la mayoría eran prosa prescindible, pero un subconjunto documentaba INVARIANTES medidos de concurrencia/seguridad (regla 4 del protocolo: esos SÍ van — "restricciones que el código no puede expresar"). Recorre los originales (`git show 1ca3312^:apps/console/src/features/terminal/pty-session.ts`, `git show 91bb5d7^:...OperatorWorkspace.tsx` y los CSS) y restaura SOLO los que cumplan: documentan una invariante, un orden obligatorio, un límite medido o un porqué de seguridad — reescritos en una línea sobria, sin fechas ni narrativa. Estimación honesta: 15–30 comentarios, no 190.

## Tarea 2 — Punteros muertos visibles al operador
`features/config/campos-inertes.ts` y `SpaceWizard.tsx` citan `repository.ts:NNNN` que ya no existen (repository quedó en 42 líneas). Actualiza cada puntero a su módulo real (`repository/config.ts:NN` etc.) — verifica cada línea destino antes de escribirla.

## Tarea 3 — Deduplicar el resolutor de @import
El helper recursivo de resolución de `@import` está copiado 11 veces en tests con dos nombres distintos y sin guardia anti-ciclos. Extrae UNO a `src/test/css-imports.ts` (con guardia), migra los 11 usos, borra las copias.

## Tarea 4 — Exports muertos (si tu r5 T3 quedó abierta) y `PtyEntry`
El barrido de exports sin importadores; y `PtyEntry` volvió export público sin consumidor externo — devuélvelo a privado del módulo si nada de fuera lo usa.

Gate por commit: consola typecheck+lint + 107/107 se mantiene + `pnpm test:unit` global. Push al cerrar + reporte ≤5 líneas.

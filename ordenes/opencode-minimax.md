# OpenCode/MiniMax — ORDEN ACTIVA (sesión nueva; 4 subagentes; verificación mecánica masiva)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. Evidencia madre: `ordenes/reportes/claude-megaauditoria.md` §3.3. Reglas: 4 subagentes máximo, nada de código de producto, push por tarea.

## Tarea 1 — Censo de TODAS las citas `fichero:línea` del árbol vivo (insumo del gate G7)
Extrae con regex toda coordenada `ruta.ext:NNN` en comentarios/JSDoc/strings de console/, services/, packages/, ops/, scripts/, tests/. Por cada una: ¿el fichero existe? ¿tiene ≥NNN líneas? Entregable `ordenes/reportes/minimax-citas-rotas.md`: cita → veredicto → destino probable. (Gemini ya corrige las 20 conocidas de console/features/config — exclúyelas.)

## Tarea 2 — Matriz de cobertura fichero → gate
Para CADA fichero versionado: qué lo toca (eslint / bash -n / shellcheck / compile() / tsc / suite / **NINGUNO**), con la columna NINGUNO primero. Entregable `ordenes/reportes/minimax-cobertura-gate.md`. Nota: calidad.mjs ahora también ve ejecutables con shebang; verifica esa cobertura nueva.

## Tarea 3 — Auditoría del trinquete completo
Las ~23 entradas de `lineas` y 32 de `fechas` de `scripts/calidad-base.json` contra el fichero real HOY: tabla de rancias (baseline >10% sobre lo real). El aviso automático ya existe (G8) — tu tabla confirma que no se le escapa nada.

## Tarea 4 — Ejecuta TUS rojos del censo de docs
De tu `ordenes/reportes/minimax-docs-que-mienten.md` (56 ROJO): corrige DIRECTAMENTE los que caen en docs/** (tu sector); los de README de otros sectores, déjalos en una tabla de traspaso por sector al final del reporte. El integrador reparte.

## Tarea 5 — Censo de propiedad del checkout
Los ficheros root:root restantes (find -user root, fuera de .git/node_modules): lista + chown exacto por fila, SIN ejecutar. (La guardia anti-root ya bloquea la fuente; esto limpia el residuo histórico.)

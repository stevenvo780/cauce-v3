# OpenCode/MiniMax — ORDEN ACTIVA (sesión nueva; 4 subagentes; tareas de MUCHO leer)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. Reglas: main directo, commit con pathspec, sin clean/reset/stash, nada de código de producto. **4 subagentes en paralelo** (no 6: rate limit). Tu ronda anterior fue excelente — este es el siguiente nivel de volumen.

## Tarea 1 — AUDITORÍA DE DIENTES de toda la suite TS (~113K líneas de test)
Recorre TODOS los `*.test.ts(x)` del árbol vivo (repárte entre 4 subagentes por directorio). Para cada FICHERO de test, clasifica sus tests en: (a) con dientes (asserts sobre efectos reales), (b) SIN dientes: cero asserts / assert de constantes / prueba-al-mock (el assert cae sobre lo que el propio mock devolvió) / snapshot-only, (c) skip/disabled, (d) tautológicos sospechosos. NO edites nada. Entregable `ordenes/reportes/minimax-dientes.md`: tabla fichero → total/con-dientes/sin-dientes/skips + los 20 PEORES con cita textual del assert vacío. Los dueños (Codex/Gemini) los arreglarán con tu mapa.

## Tarea 2 — CAZA DE DUPLICADOS copy-paste (el caso @import×11 a escala repo)
Busca bloques/funciones casi idénticos repetidos entre ficheros (mismo cuerpo normalizado, helpers copiados, validaciones repetidas): compara por paquete y cruzando paquetes. Entregable `ordenes/reportes/minimax-duplicados.md`: grupo → ficheros:líneas → tamaño del duplicado → sugerencia de hogar único. Solo evidencia textual verificable (cita ambos lados).

## Tarea 3 — ACELERADOR de la limpieza de comentarios (P14)
Para cada fichero de la tabla de `ordenes/reportes/claude-censo-comentarios-basura.md` con borrables restantes: produce la LISTA EXACTA de líneas a borrar (`ruta:línea-línea` + primera palabra) clasificada narrativo/mutilado/ceremonial, respetando invariantes y sin tocar sql-strings. Entregable `ordenes/reportes/minimax-lineas-p14.md` — con eso Codex/Gemini borran por número sin re-leer. (Es lectura masiva de precisión: lo tuyo.)

## Tarea 4 — CHANGELOG humano del gran día
`git log --since="2026-08-27 00:00"` (~160 commits): escribe `CHANGELOG-2026-08-27.md` en la raíz — agrupado por área (auditoría/purga/particiones/tooling/fase3), una línea por cambio REAL (fusiona los commits triviales), con los números del día (líneas borradas, ficheros partidos, tests verdes). Para el dueño y para la historia.

## Tarea 5 — Re-verificación de datos de PENDIENTES-DEL-DUEÑO.md
Cada número y afirmación del doc, re-verificado con comandos HOY (ya hubo una cifra inflada 4,5×). Corrige lo desviado citando el comando. El dueño va a firmar sobre esto: tiene que ser verdad.

Push al cerrar cada tarea + reporte ≤5 líneas por tarea.

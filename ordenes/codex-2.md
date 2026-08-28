# Codex-2 — ORDEN ACTIVA (ronda 2): la molienda que declaraste hecha NO lo está — evidencia primero

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Tu ronda anterior cerró declarando "terminado" con **517 problemas de lint estricto en pie y 11 líneas sin commitear** (el integrador las commiteó). Medido HOY por sub-zona: `packages/protocol/src` **20** · `packages/mcp-fleet-monitor/src` **15** · `packages/store/src` **136** · `services/gateway/src` **346**. Regla del protocolo: nada está hecho sin efecto demostrado — esta vez cada tarea cierra pegando el comando en verde. Zona EXCLUSIVA sin cambios: esas 4 rutas y nada más. `umask 022` da igual (corres como root, está bien); commit+push POR SUB-ZONA.

## Tarea 1 — protocol y mcp a CERO (35 problemas, tarde corta)
`npx eslint -c eslint.estricto.config.js packages/protocol/src` y `.../mcp-fleet-monitor/src`: `--fix` lo mecánico, a mano el resto. PROHIBIDO silenciar con disable salvo falso positivo justificado en el propio disable (inglés). Cierra pegando `0 problems` de ambas.

## Tarea 2 — store a CERO (136)
Mismo protocolo. Sub-commits por directorio (`repository/`, `configuration/`, resto). Cierra con `0 problems` pegado.

## Tarea 3 — gateway a CERO (346, la grande — paraleliza en oleadas de 4 por subcarpeta: `routes/`, `terminal/`, `console/`, `health/`+raíz)
Mismo protocolo. Cierra con `0 problems` pegado.

## Tarea 4 — Comentarios de CÓDIGO en inglés en TUS 4 zonas (regla de idioma del dueño)
Mientras moles cada fichero: comentario en español → inglés conciso; narrativa/ceremonial → borrar; invariantes → traducir con fuerza. Ni un byte de sql-strings.

## Tarea 5 — Promoción al gate (el cierre real)
Por cada sub-zona en CERO: añade su ruta al script `lint:estricto` de `package.json` (el integrador ya lo declaró: promover zona limpia = que el gate la vigile para siempre). Gate global verde por commit.

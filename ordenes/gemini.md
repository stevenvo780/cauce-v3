# Gemini — ORDEN ACTIVA (ronda nocturna, larga y AUTÓNOMA — el dueño duerme, el integrador también)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Tu ronda anterior: **console, terminal-relay y telegram-bridge a CERO problemas en nivel estricto** + G2 + G3 — de lo mejor de toda la restructuración. Esta noche NADIE revisa en vivo: cada tarea cierra con su comando en verde PEGADO en el commit y push inmediato. Si algo te bloquea, sáltalo, anótalo en tu reporte y sigue. Zonas EXCLUSIVAS de esta orden: `services/dispatcher/**` · `tests/**` (TODO el árbol de tests de la raíz) · `console/**` · `services/terminal-relay/**` · `services/telegram-bridge/**` · `ops/runbooks/**`. Nada de `ops/scripts`, `packages/*`, `services/gateway`.

## Tarea 1 — Promover tus 3 zonas limpias al gate (que lo limpio se quede limpio)
En `package.json` crea `lint:estricto:zonas` = `eslint -c eslint.estricto.config.js console services/terminal-relay services/telegram-bridge --max-warnings 0` y encadénalo dentro de `pnpm lint` (tras `lint:tooling`). Gate global verde, commit, push. A partir de aquí nadie puede ensuciar esas zonas sin ponerse rojo.

## Tarea 2 — `services/dispatcher/src` a CERO (13 problemas — calentamiento)
Mismo protocolo de siempre; ciérrala con `0 problems` pegado y añade la ruta a `lint:estricto:zonas`.

## Tarea 3 — `tests/**` a CERO (419 problemas — el plato fuerte de la noche; oleadas de 4 por directorio)
`tests/unit` · `tests/gateway-hardening` · `tests/store-hardening` · `tests/integration`+`e2e` · `tests/terminal-pty`+`helpers`. Por directorio: medir → `--fix` (commit) → a mano (commit) → `0 problems` pegado → añadir al script de zonas. OJO: `tests/helpers/postgres.ts` lo importan 46 ficheros con ruta literal — NO lo muevas ni renombres, solo límpialo por dentro. Los tests que ejecutan scripts por subproceso (25 de tests/unit leen deploy/ y ops/ del disco) NO cambian de comportamiento: solo limpieza de tipos/estilo. Gate global (incluido `pnpm test:unit`) verde por commit.

## Tarea 4 — Comentarios de código → INGLÉS en todo lo que toques (regla del dueño)
En cada fichero de las Tareas 2-3 que abras: comentario en español → inglés conciso; narrativa/ceremonial/fechas/nombres → fuera; invariantes → traducidos con fuerza. `tests/**` es también zona de minimax-2 para traducción: coordinación simple — TÚ vas por directorio en el orden de la Tarea 3 y lo anotas en cada commit ("tests/unit traducido"); si al hacer pull ves que minimax-2 ya tradujo un directorio, no lo repitas.

## Tarea 5 (si sobra noche) — Asserts-sobre-texto de consola del top-20 de `ordenes/reportes/minimax-dientes.md`
Solo los citados en el top-20; conviértelos en asserts de comportamiento. Los 74 restantes esperan al mega-refactor.

## Cierre: reporte en `ordenes/reportes/gemini-nocturna.md` — por tarea: comando de verificación + salida en verde + commits. ≤20 líneas. Push.

# Codex-2 — ORDEN ACTIVA: MOLIENDA ESTRICTA de los paquetes backend (zona DISJUNTA de codex-1)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Eres la SEGUNDA instancia codex: tu compañero trabaja EXCLUSIVAMENTE en `ops/scripts` + `ops/tests` (flota-como-datos). TU zona es DISJUNTA y solo tuya: **`packages/protocol/src` · `packages/store/src` · `packages/mcp-fleet-monitor/src` · `services/gateway/src`**. Ni un fichero fuera de ahí. Reglas: pathspec, `umask 022`, commit+push por sub-zona.

## La misión (dictado del dueño): nivel de lint MÁXIMO + comentarios de código en INGLÉS
Medido: `pnpm lint:estricto` (config `eslint.estricto.config.js` = strictTypeChecked + stylisticTypeChecked) arroja 4.355 problemas en el repo; tu parte es la de tus 4 zonas. Protocolo POR SUB-ZONA (protocol → mcp → gateway → store):
1. Mide: `npx eslint -c eslint.estricto.config.js packages/protocol/src` — pega el número.
2. `--fix` para lo mecánico, commit aparte; luego A MANO lo real (unsafe-*, no-unnecessary-condition, prefer-nullish-coalescing…). PROHIBIDO silenciar con disable salvo falso positivo justificado EN el propio disable (inglés, 1 línea).
3. En el MISMO pase: todo comentario de código que toques o leas en el fichero → INGLÉS conciso (regla de idioma 28-08); narrativa/ceremonial se BORRA, invariantes se conservan traducidos. Ni un byte de sql-strings.
4. Sub-zona en CERO → pega el comando en verde y avisa en tu reporte: el integrador la promueve al gate.
5. Gate global por commit (typecheck+lint+test:unit). El trinquete de comentarios BAJARÁ solo (solo tapa hacia arriba).

## PROHIBIDO: tocar ops/** (codex-1), console/services-relay/bridge (gemini), tests de adapter-sdk (minimax-1). Los identificadores exportados NO se renombran aún (eso es la homogenización con presupuesto, otra ronda).

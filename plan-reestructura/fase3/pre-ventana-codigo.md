# Código a arreglar en main ANTES de la ventana (sin esto, desplegar regresa incidentes)

El hallazgo grave de la reconciliación: **main no es superconjunto de lo que corre**. Producción vive con parches `.js` montados por override cuyos arreglos nunca entraron a main. Portarlos es requisito de la ventana.

## 1. Regex de base64 (incidente del 6-ago) — CRÍTICO
`packages/protocol/src/schemas.ts:158` conserva el regex que agrupa de a 4 con `*`: con adjuntos de varios MB, V8 revienta con `RangeError: Maximum call stack size exceeded`, que NO es ZodError → escapa del manejo → el poller de Telegram reintenta el MISMO lote para siempre (medido: 186 reintentos, dos reinicios no lo cortaron). El arreglo existe en el commit `a9ad652` (el objeto sigue en el repo y en el bundle de archivo; la rama fue purgada): portarlo a main (validación sin regex catastrófico) + test con un payload de varios MB.
**Ejecutor sugerido:** Codex (protocol es núcleo). Verificación: el parche `protocol-schemas-regex-20260806.js` de `/etc/cauce-v3/patches/` queda obsoleto.

## 2. Pie de fan-in que llega al Telegram del dueño
`packages/adapter-sdk/src/sdk/fanin-synthesizer.ts:235` emite SIEMPRE el pie `[N locally synthesized branch reply; …]` — telemetría interna que llegaba textual al chat. El parche vivo (`fanin-synthesizer.js`) lo apaga. Portar: suprimirlo o ponerlo tras flag (`CAUCE_FANIN_FOOTER`, default apagado) + test.
**Ejecutor:** Codex o Claude.

## 3. Auditar `store-repository.js` (el parche opaco)
Montado solo en telegram-bridge. Sus marcadores (`acusarAhora`, `isDelegatedSubAgentTurn`, `ackVentanaSilencioMs`, `normalizeRoleBrief`) dan **0 hits en el fuente de main** — y un comentario de la consola referencia `normalizeRoleBrief` en un fichero donde no existe. Diffear el `.js` del parche contra el build de main del mismo fichero, identificar qué lógica añade, y portarla o descartarla CON razón escrita. Hasta entonces, el override `store-fanin.yaml` no se puede retirar.
**Ejecutor:** Codex (store es su sector).

## 4. `deploy/Dockerfile` roto
Referencias a `services/relay-worker` y `services/shadow-router` (líneas 18-19, 48-49, 57-58, 90-91) que ya no existen. Sin esto no se hornea ninguna imagen. **Ejecutor:** Claude (deploy es FASE 3).

## 5. Compose canónico
Escribir `deploy/compose.yaml` según `compose-canonico.md` (9 cambios + borrado de 3 servicios). **Ejecutor:** Claude + dueño revisa.

## 6. Launcher PTY — que el bucle no reaparezca
`ops/pty-agent/cauce-pty-launcher.sh:783-801`: el flock vive en el host y muere con el cliente; el proceso del contenedor sobrevive; no hay reconciliación. Arreglo: antes del `exec docker exec…`, matar cualquier `cauce-pty-agent-<alias>.py` preexistente dentro del contenedor (con guarda por nombre de script). Sin esto, **el bucle de expulsión reaparece en el próximo rollout**, incluida la propia ventana.
**Ejecutor:** Claude + dueño (toca la flota).

## 7. Los 13 tests de consola que quedan en rojo
El fix de AbortSignal bajó los fallos de 533 → 13 (6 ficheros). Rematar las causas restantes para que `pnpm test:unit` entre al gate global.
**Ejecutor:** Codex (cierre de su Tarea 2), coordinado con Gemini si toca ficheros de consola.

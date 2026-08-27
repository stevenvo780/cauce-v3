# Codex — ORDEN ACTIVA (la gran final de tu sector: CERO ficheros >800, en oleadas paralelas)

Excelente cierre anterior (matriz en verde, health 295, authentic retirada, jerarquía reparada). Queda LO GRANDE: tu Tanda 2 nunca se ejecutó y tu sector concentra ~16 ficheros >800. Protocolo de siempre; **oleadas de 4 subagentes** (ficheros disjuntos, tú integras) hasta vaciar la lista. Estándar byte-puro + las lecciones acumuladas (reindentar, no abrir exports, no invertir jerarquías, no borrar invariantes).

## La lista — ACTUALIZADA 27-08 tarde (¡ya partiste 8 de 16! durable-store→90, paste-runner→8, tmux→59, engine→786, output-parser→27, shared→29, deliveries→27, fanin→289 — verificado). Quedan estos 8 (re-mide con wc -l):
**store**: `repository/observability.ts` · `repository/agents/chain-control.ts` · `repository/outbox.ts` · `repository/messages.ts` · `configuration.ts`
**gateway**: `routes/core.ts` · `terminal/relay-proxy.ts` · `console/agent-documents.ts`

## Regla dos-en-uno: al partir cada fichero, aplica SU fila del censo de comentarios
`ordenes/reportes/claude-censo-comentarios-basura.md`: en el mismo commit de partición, borra lo narrativo/mutilado/ceremonial de ESE fichero (con su cifra), conserva invariantes compactados, y **ni un byte de los sql-strings**. Los `// S1`…`// S6` de deliveries.ts: definir o borrar. Así la lista y la limpieza caen juntas.

## Cierre
0-pre. **Rojo de e2e**: 1 rojo quirúrgico en pnpm test:e2e — ver ordenes/reportes/minimax-matriz-cd.md §2; investiga arnés vs producto. 
0. **Rojos de store-hardening (matriz, tuyos)**: `packages/store/test/terminal-relay-instance-fencing-migration-postgres.test.ts` — 5 tests rojos porque su setup baja la 036 con la 037 presente (arnés desactualizado desde c7345da; bajar 037 primero o construir el estado pre-034 por otra vía). Y los otros 4 ficheros rojos del carril B: identifícalos con `pnpm test:store-hardening` y arregla el ARNÉS (no migraciones — NO-TOCAR).
0-bis. **`routes/legado-candidato.ts`: veredicto ejecutable** — publish-intents NO es legado (ya lo sabes): sácalo de ahí a `routes/console-publish.ts` SIEMPRE montado; chain-gates (0 filas, 0 llamadores) se queda solo en ese fichero, que pasa a llamarse `routes/chain-gates-legado.ts` — la decisión final de chain-gates es del dueño (PENDIENTES).
1. Intake de `ordenes/reportes/claude-revision-ola3.md` cuando llegue (lo tuyo).
2. Verificación final: `wc -l` de los tres paquetes — CERO ficheros >800 sin justificación de una línea. Pega la lista.
3. Gate GLOBAL por commit + push al cerrar cada oleada + reporte ≤5 líneas.

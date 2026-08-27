# Codex — ORDEN ACTIVA (la gran final de tu sector: CERO ficheros >800, en oleadas paralelas)

Excelente cierre anterior (matriz en verde, health 295, authentic retirada, jerarquía reparada). Queda LO GRANDE: tu Tanda 2 nunca se ejecutó y tu sector concentra ~16 ficheros >800. Protocolo de siempre; **oleadas de 4 subagentes** (ficheros disjuntos, tú integras) hasta vaciar la lista. Estándar byte-puro + las lecciones acumuladas (reindentar, no abrir exports, no invertir jerarquías, no borrar invariantes).

## La lista (mídela primero con wc -l por si alguna cambió; parte TODO lo >800)
**adapter-sdk**: `sdk/durable-store.ts` (2.060) · `shared-session/paste-runner.ts` (1.900) · `shared-session/tmux.ts` (1.529) · `sdk/engine.ts` (1.322) · `sdk/output-parser.ts` (1.189) · `harnesses/shared.ts` (1.133)
**store**: `repository/deliveries.ts` (1.493) · `repository/agents/fanin.ts` (1.438) · `repository/observability.ts` (1.420) · `repository/agents/chain-control.ts` (1.335) · `repository/outbox.ts` (1.286) · `repository/messages.ts` (1.161) · `configuration.ts` (1.145)
**gateway**: `routes/core.ts` (1.448) · `terminal/relay-proxy.ts` (1.141) · `console/agent-documents.ts` (1.080)

## Regla dos-en-uno: al partir cada fichero, aplica SU fila del censo de comentarios
`ordenes/reportes/claude-censo-comentarios-basura.md`: en el mismo commit de partición, borra lo narrativo/mutilado/ceremonial de ESE fichero (con su cifra), conserva invariantes compactados, y **ni un byte de los sql-strings**. Los `// S1`…`// S6` de deliveries.ts: definir o borrar. Así la lista y la limpieza caen juntas.

## Cierre
1. Intake de `ordenes/reportes/claude-revision-ola3.md` cuando llegue (lo tuyo).
2. Verificación final: `wc -l` de los tres paquetes — CERO ficheros >800 sin justificación de una línea. Pega la lista.
3. Gate GLOBAL por commit + push al cerrar cada oleada + reporte ≤5 líneas.

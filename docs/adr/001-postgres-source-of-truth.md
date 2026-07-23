# ADR-001: PostgreSQL como fuente transaccional única

**Estado:** aceptado.

Todas las decisiones durables (mensaje, entrega, lease, ACK, outbox, job y DLQ) se escriben en PostgreSQL. El WebSocket es únicamente un acelerador de push; una reconexión siempre drena la cola desde la base.

Las adquisiciones competitivas usan transacciones y `FOR UPDATE SKIP LOCKED`. Publicación, deduplicación, fan-out y eventos wake se confirman en una sola transacción. ACK terminal y relay de origen también son atómicos. No se elimina una entrega: sus estados terminales y auditoría permanecen consultables.

-- Reversa de 017_late_terminal_ack.sql.
--
-- Ojo con el orden: primero hay que desplegar el código anterior (el que no proyecta
-- `d.late_result_at` en el SELECT de `ackDelivery`) y recién después correr esto. Al revés,
-- entre el DROP y el redeploy cada ACK falla con 42703 y el bus queda mudo.
--
-- Volver atrás no deshace los rescates ya aceptados: las entregas que se revivieron a 'done'
-- siguen en 'done' con su resultado, y sus avisos ya salieron. Lo único que se pierde es la
-- marca de "acá hubo un rescate", con dos consecuencias: la auditoría (`delivery.late_result`)
-- pasa a ser la única traza, y una entrega que quedó 'dead' tras un 'failed' tardío vuelve a
-- ser candidata a un segundo rescate si el código nuevo se redesplegara.
--
-- Se borra `late_result_attempt` primero por simetría con el orden de creación; ninguna de las
-- dos tiene dependencias (no hay índices, vistas ni constraints que las nombren).

-- INTEGRACIÓN 2026-07-29: `cancelled_at` va PRIMERO y merece su propia advertencia. Bajarla no
-- sólo pierde una marca: reabre la puerta que cerraba. Una entrega que un operador canceló
-- vuelve a ser candidata a que un ACK terminal tardío la rescate, y eso le manda al padre una
-- SEGUNDA `agent.response` por la misma delegación. Si hay que bajar el esquema, bajá también el
-- código de cancelación (018) o dejá esta columna en su lugar: no tiene dependencias y no cuesta
-- nada tenerla de más.
ALTER TABLE deliveries DROP COLUMN IF EXISTS cancelled_at;

ALTER TABLE deliveries DROP COLUMN IF EXISTS late_result_attempt;
ALTER TABLE deliveries DROP COLUMN IF EXISTS late_result_at;

# ADR-003: Outbox, routing default-deny y lanes

**Estado:** aceptado.

El routing exige membresía activa del actor en su room, membresía del destinatario y una arista ACL dirigida con `allow_route`. Tenants y aristas son datos: no existe enum ni hub hardcodeado en el protocolo; cada permiso `route/read/control` nace en `false`. La visibilidad exige participación real y `allow_read`, no solo compartir hub.

`adapter_outbox` desacopla wake y relay al origen, manteniendo request/message/delivery/trace. Claim y ACK de delivery/outbox se correlacionan con `event_id+attempt+claim_token`, deadline independiente y lease cercado. Los jobs usan lanes `interactive` y `batch`: prioridad dentro de lane y streak transaccional en PostgreSQL para acotar starvation entre varios dispatchers.

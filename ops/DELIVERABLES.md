# Entregables de gates

Estado implementado, todavía no desplegado:

- snapshot por alias v2 bajo corte PostgreSQL consistente;
- poller auténtico por lease+heartbeat y prueba publish→delivery→ACK model-free;
- baseline obligatorio y DLQ delta, preservando DLQ histórico;
- canary/cutover fail-closed con cleanup y timeout;
- flota exacta de 15 agentes, un principal de sistema y tres históricos;
- filtro compartido de `gate-probe` y `quota-collector` en destinos/routing;
- policy `agent_notify` exacta y verificada por snapshot v3;
- placements físicos declarados y gate de existencia Docker;
- excepción de mantenimiento únicamente para Zeus, con confirmación exacta y gate final obligatorio;
- down 028/029 coordinados con el advisory lock del migrador; down 029 además bloquea writers y
  rechaza cualquier conflicto CAS antes de mutar o borrar `schema_migrations`.

No se realizó deploy, reinicio, activación de units ni lectura/escritura de secretos. Antes de
producción faltan regenerar artefactos derivados de units/checksums desde el inventario final,
provisionar la identidad mTLS fuera del repo y ejecutar el release gate en el host autorizado.

Límite explícito: migraciones 001–023 siguen con evidencia name-only. Los gates actuales no deben
describirse como integridad histórica total; ver `GATE_CONTRACT.md`.

# @cauce/protocol

Schemas Zod del protocolo wire `3.0`. Es el contrato entre todo lo demás y **se compila primero**: `pnpm prepare:runtime` (los demás paquetes consumen su build).

**Principios:**
- El payload público de publicación es `strict` y tiene PROHIBIDO llevar identidad (`tenant_id`, `actor_alias`, `session_id`, `channel`, `origin`, `trace_id`…): toda identidad la deriva el gateway del principal autenticado.
- ACK como escalera monotónica `accepted → started → done|failed`, cada evento con `event_id` + `attempt` + `claim_token`; un `event_id` repetido nunca aplica otra transición.
- Sin enums de tenants ni nombres hardcodeados en el protocolo.

**Probar:** `vitest run packages/protocol/test` (incluido en `pnpm test:unit`).

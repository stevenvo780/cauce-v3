# Shadow router V2 ↔ V3

Este proceso no adquiere identidad de consumer ni leases de delivery en V2/V3. Solo
acepta eventos por un outbox PostgreSQL propio o por un Unix socket local. El
directorio padre del socket debe ser privado (`0700`) y el socket queda `0600`; esa
DAC del sistema operativo es la autenticación local. No lee tokens ni sesiones V2.

## Modos

- `shadow` (default): llama exclusivamente `/shadow/preview` con
  `allow_human_reply=false` y `allow_harness=false`.
- `compare`: igual de read-only y guarda solo hashes SHA-256, tamaños y verdict
  `match/mismatch/no_baseline`; nunca persiste bodies de comparación.
- `cutover`: exige simultáneamente
  `SHADOW_ROUTER_ENABLE_CUTOVER=I_UNDERSTAND_ONE_ACTIVE_PATH` y una única
  `SHADOW_ROUTER_CUTOVER_DIRECTION=v2-to-v3|v3-to-v2`. La dirección contraria falla
  cerrada.

El target recibe `target_event_id` estable como `Idempotency-Key` y debe honrarlo.
`shadow_human_reply_guards` permite una sola ruta humana por tenant/correlación; un
retry del mismo mapping conserva el mismo ID. En shadow/compare el método de cutover
no puede ejecutarse por diseño de interfaz.

## Variables no secretas

- `SHADOW_ROUTER_SOCKET`: socket de ingress/health/metrics.
- `SHADOW_ROUTER_V2_SOCKET`, `SHADOW_ROUTER_V3_SOCKET`: endpoints locales target.
- `SHADOW_ROUTER_TENANTS`: allowlist separada por comas.
- `SHADOW_ROUTER_MODE`: opcional, default `shadow`.

`DATABASE_URL` se entrega por el mecanismo encapsulado del deployment. Debe estar
aplicada `005_channel_bridges.sql`.

Endpoints en el Unix socket:

- `POST /ingress/v2` para `direction=v2-to-v3`.
- `POST /ingress/v3` para `direction=v3-to-v2`.
- `GET /health/live`, `GET /health/ready`, `GET /metrics`.

Cada envelope requiere `source_event_id`, `tenant_id`, `correlation` con
`request_id/trace_id`, `payload` y `expects_human_reply`. La correlación se conserva
sin regenerarla. Duplicados de dirección+source_event_id retornan el mismo mapping y
nunca crean una segunda entrega humana. Cambiar de modo no reprocesa mappings
anteriores; filas encoladas con otro modo fallan cerradas.

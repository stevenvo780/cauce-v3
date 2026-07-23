# Threat model — Cauce V3

## Activos y fronteras

PostgreSQL contiene payloads, topología, leases, ACKs, jobs y auditoría. Gateway
es la frontera HTTP/WS; consola y adapters son clientes no confiables.
Dispatcher y gateway coordinan por filas/leases PostgreSQL. Prometheus/OTel solo
reciben agregados sin tenant/payload.

## Amenazas y controles implementados

| Amenaza | Control actual |
|---|---|
| Suplantación de actor/tenant/session/channel | Payload publish strict y gateway deriva identidad desde `Principal`; hello WS se compara con el principal. |
| Dev auth en producción | `DevOnlyAuthProvider` es rechazado con `NODE_ENV=production`; sin provider productivo gateway no arranca. |
| Segundo consumer / split brain | Lease por `(tenant,alias)`, epoch monotónico y fencing de heartbeat/claim/ACK. |
| Confused deputy multi-tenant | Membresía, ACL default-deny y facades filtradas por principal. |
| Replay/idempotency mutation | Key ligada a hash semántico; constraints deduplican delivery/outbox. |
| ACK duplicado/viejo/perdido | Rango monotónico, owner+epoch, historial ACK, timeout/retry y DLQ. |
| Caída entre persistencia y push | PostgreSQL es durable; `LISTEN/NOTIFY` solo acelera y outbox wake reintenta. |
| Job no-op o poison kind | Registry explícito por kind; completar requiere handler resuelto y ejecutado. Kind desconocido pasa atómicamente a `dead`+DLQ. En producción solo existe `system.database.probe`; QA se registra únicamente con `NODE_ENV=test`. |
| Starvation | Jobs tienen lanes `interactive|batch`, prioridad y burst interactivo acotado. |
| Browser como autoridad | Cookie same-origin, body allowlisted, sin storage de tokens. Mutaciones requieren snapshot RBAC exacto; permiso ausente/endpoint faltante queda UNKNOWN y bloqueado. Estados fuera de enum quedan UNKNOWN. |
| Terminal como broker implícito | Ultimate Terminal es plugin cliente lazy, same-origin, sin query credentials, y exige plugin id, capability `terminal.pty.client` y permiso `ultimate-terminal.connect`. |
| DB sin cifrar en producción | Readiness exige modo TLS y confirma `pg_stat_ssl.ssl=true`; probes Compose y backup/restore aplican la misma política. `verify-full` es la recomendación operativa. |
| Runtime con toolchain | Imagen final usa usuario `node`, JS compilado y dependencias production; comandos son `node .../dist/main.js`, sin tsx/devDependencies. |
| Observabilidad engañosa | Dispatcher y `outbox-metrics` consultan PostgreSQL en cada scrape y emiten gauges para queue/retry/DLQ/leases y wake/outbox/relay; si falla, la serie `*_query_success=0` evita inventar ceros. |
| QA mocked acreditado como real | Reportes separan `protocol-double`, mocked y authentic restart. Evidencia real/restart exige cero skips; un perfil restart mal configurado falla antes de ejecutar y conserva PID/container/timestamps cuando aplica faults. |
| XSS/estilos dinámicos de xterm | CSP mantiene scripts y style elements en `self`; solo `style-src-attr 'unsafe-inline'` permite la geometría dinámica de xterm. |

## Riesgos y bloqueos pendientes

- OIDC/JWKS, mTLS, token-file y `/v3/console/access` existen, pero cada entorno
  debe aportar certificados/identity maps/provider correctos y evidenciar
  negativos/rotación. Configuración incompleta falla cerrado.
- El worker `origin_relay` existe, pero el provider firmado y su receiver
  idempotente son dependencias externas. `sent` solo se acredita con `sent_at`;
  Telegram y relay genérico no pueden competir por el mismo adapter.
- Los manifests de flota describen wrappers auténticos por PATH. No convierten
  los protocol doubles ni el adapter CLI bundled en autenticación productiva;
  WSS/token/client-cert deben verificarse en el wrapper del entorno.
- No hay rate limits/cuotas, cifrado de payload a nivel aplicación ni política
  completa de retención/particionado de ACK/audit.
- El modo `sslmode=require` cifra pero no valida identidad del servidor;
  producción debe usar `verify-full` y CA gestionada fuera del repositorio.
- Gateway aún no expone métricas propias; las alertas incluidas cubren el
  dispatcher y estado durable, mientras gateway se vigila por health/orquestador.
- HA administrada (failover PostgreSQL, LB multi-gateway, RPO/RTO) no está
  acreditada por Compose. Ver `ops/runbooks/ha.md`; hasta completar ese gate la
  arquitectura es piloto, no producción HA.

# @cauce/gateway

Único punto de entrada del sistema: HTTP + WebSocket.

**Hace:** valida y publica mensajes (`POST /v3/messages|/v3/publish`, re-verifica el recibo contra el efecto durable antes de contestar 202); sirve el WS de los adapters (`GET /v3/ws`, hello + claims + ACKs con fencing); deriva TODA identidad (tenant, actor, canal, origin) del principal autenticado — el payload público es `strict` y rechaza esos campos; expone las fachadas de la consola (`/v3/console/*`) y el plano de control de terminal (`terminal/plugin.ts`: targets, tickets HMAC de sesión, proxy de presencia del relay, sondas de gobierno).

**No hace:** entregar mensajes (eso lo hace el pull del adapter) ni ejecutar modelos.

**Auth:** proveedores OIDC / mTLS / token-file / password para la consola; `CAUCE_DEV_AUTH=1` solo fuera de producción (fail-closed sin proveedor).

**Salud:** `GET /health/live`, `GET /health/ready`, `GET /v3/status`.

**Correr en dev:** `pnpm dev:gateway`. **Probar:** suites en `tests/gateway-hardening/` y unit del paquete.

**Aviso:** `src/app.ts` ya está modularizado (408 líneas que componen `routes/*`); la partición de `terminal/plugin.ts` vive en `services/gateway/src/terminal/{session-control,relay-proxy,authority,registry,governance-probes,audit,tickets,types,config}.ts`. publish-intents está SIEMPRE montada (`routes/console-publish.ts`); chain-gates (0 uso medido) es candidata a retiro con `git rm` y vive en `routes/chain-gates-legado.ts` detrás de `enableLegacyCandidateRoutes`, a decisión del dueño.

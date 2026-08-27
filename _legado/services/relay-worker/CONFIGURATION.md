# Origin relay worker configuration

`OriginRelayWorker` consumes only fenced `origin_relay` leases. The repository must
return `event_id`, positive `attempt`, and an opaque `claim_token`, and atomically
accept ACKs containing those same values with status `sent`, `retry`, or `dead`.
Legacy ID-only outbox completion is deliberately rejected.

The worker claims **per registered adapter**: it iterates `transports.adapters()`
(the exact set from `CAUCE_RELAY_ADAPTERS`) and issues one adapter-scoped claim per
adapter. It never issues an unscoped claim, so it can only ever lease `origin_relay`
events for adapters it serves. In particular it never poaches `telegram` events
(owned by the telegram-bridge) unless `telegram` is explicitly listed in
`CAUCE_RELAY_ADAPTERS` — which it is not.

Register one `OriginTransport` per adapter. `HttpWebhookOriginTransport` requires:

- one or more exact HTTPS origins in an allowlist;
- a `WebhookProvider` that resolves the destination and signs the exact payload;
- an optional injected `fetch` implementation and timeout.

The provider encapsulates secret lookup and signing. The worker receives only the
signature output and never reads, stores, or logs signing material. Redirects are
disabled, endpoints with credentials are rejected, and the stable `event_id` is sent
as the downstream idempotency key. A receiver must honor that key because a crash
after remote success but before the fenced ACK can cause safe redelivery.
Before a production connection, DNS is resolved and every answer must be public;
the HTTPS socket is pinned to a validated answer while preserving TLS SNI/hostname
verification. This blocks private/link-local targets and DNS rebinding between
validation and connect.

Retryable network, 408, 425, 429, and 5xx failures back off exponentially. Terminal
4xx failures, missing transports, allowlist violations, and exhausted attempts ACK
`dead` for repository DLQ handling.

El claim es incremental: una lease fresca por adapter y por ciclo. El valor histórico
`CAUCE_RELAY_BATCH_SIZE` todavía se acepta para que un entorno antiguo no deje de arrancar,
pero el worker lo acota deliberadamente a `1`. `CAUCE_RELAY_HTTP_TIMEOUT_MS` es un deadline
total (provider, firma, DNS y HTTP), no sólo el timeout del socket, y
`CAUCE_RELAY_LEASE_MS` debe cubrirlo con al menos 5 segundos para persistir el ACK. Un retorno
`ackOutbox(...).applied=false` se cuenta como `fenced`, nunca como `sent` y nunca provoca un
segundo ACK de retry después de un efecto remoto.

## Runnable service

`pnpm --filter @cauce/relay-worker start` wires the PostgreSQL repository and HTTP
transport. Configure these non-secret selectors/settings:

- `CAUCE_WEBHOOK_PROVIDER_MODULE`: trusted local/package module exporting
  `createWebhookProvider`; remote/data modules are rejected.
- `CAUCE_RELAY_ADAPTERS`: comma-separated adapter names handled by this worker.
- `CAUCE_RELAY_ALLOWED_ORIGINS`: comma-separated exact HTTPS origins.
- Optional positive integers: `CAUCE_RELAY_HTTP_TIMEOUT_MS`,
  `CAUCE_RELAY_LEASE_MS`, `CAUCE_RELAY_BATCH_SIZE` (compatibilidad; runtime siempre 1), `CAUCE_RELAY_MAX_ATTEMPTS`,
  `CAUCE_RELAY_BASE_RETRY_MS`, and `CAUCE_RELAY_POLL_MS`.
- `PORT` (default 8083) expone `/health/live`, `/health/ready` y `/metrics`; no incluye tenant, URL ni payload como labels.

`/health/live` falla si el loop excede su deadline acotado. `/health/ready` exige además
PostgreSQL, al menos un adapter y un ciclo exitoso reciente; un ciclo sin eventos cuenta como
progreso legítimo. Los contadores son locales al proceso y se reinician explícitamente junto con
`cauce_origin_relay_process_start_time_seconds`. Prometheus descubre este servicio por DNS, por
lo que un profile deliberadamente ausente no crea un target fantasma; si existe y no responde,
o si aparece backlog durable sin progreso, las alertas sí se activan.

`DATABASE_URL` is supplied by the deployment secret mechanism. The provider module,
not this worker, owns signing-key lookup/use and must not return key material.
The runtime image executes it as the non-root `node` user; Compose enables it only
under the explicit `origin-relay` profile and fails closed if provider/allowlist/adapters
are missing.

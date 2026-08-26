# Cauce V3 Console

React/Vite operator console in the canonical pnpm workspace. It consumes only gateway facades under `/v3/console/*` and `/v3/status`; it does not connect as a delivery consumer or own durable state.

Publishing is a server-journaled transaction. The client first allowlists
`{room_id,recipients,body,lane,priority,intent_nonce}` into `/v3/console/publish-intents`; the nonce
is a fresh in-memory UUIDv4 for one deliberate submit, while the authenticated gateway derives the
operator scope and returns an opaque idempotency key. Retries inside that submit reuse the nonce.
If a reload creates a new nonce while an identical reservation still has no effect, the server
coalesces it onto that existing key; this closes the prepare-vs-publish race that could otherwise
duplicate a message. A second deliberate identical submit becomes a new effect after the first is
durably confirmed. The
client then allowlists the semantic command plus the issued key into `/v3/console/messages`, accepts
only the exact durable receipt, and confirms it through `/v3/console/publish-intents/confirm`.

After a reload or rollback, a prior **committed** effect is reconciled. A new nonce that meets an
unconfirmed committed effect receives the exact fenced 409 receipt; the UI confirms and reports
that effect without issuing another publish. A matching reservation whose prepare response was lost
but has no effect is safely reused rather than duplicated. A late owner receives the
exact 410 `publish_intent_expired` and keeps its draft without an automatic resubmit. New reservations
are bounded per authenticated operator to 60 new nonces per ten minutes and 200 per day; an exact
429 carries the server retry interval and likewise
does not erase or resend the draft. The browser owns no durable publish state and never persists a
body, key, nonce or authentication context. The release gate rejects Web Storage, IndexedDB,
CacheStorage, OPFS and script-readable cookie access anywhere in the console source.

Actor, tenant, session, channel, request/trace and origin are server-derived. Production uses the gateway OIDC BFF: the UI navigates to `/v3/auth/login`, sends only the `__Host-` HttpOnly session cookie, and keeps the CSRF value in React/API-client memory. It never receives bearer/refresh tokens and never uses browser storage for credentials. Explicit demo builds may set `VITE_CAUCE_DEV_AUTH=1`, `VITE_CAUCE_DEV_TENANT` and `VITE_CAUCE_DEV_ALIAS`; never enable that build in production.

```sh
pnpm --filter @cauce/console dev
pnpm --filter @cauce/console lint
pnpm --filter @cauce/console typecheck
pnpm --filter @cauce/console test
pnpm --filter @cauce/console build
```

MSW exists only in `src/mocks` for unit/contract tests or `dev:mock`; normal dev/build uses the real gateway. Nginx proxies `/v3` and WebSocket to `gateway:8080` and serves the SPA with restrictive headers.

Mutating controls default closed unless `/v3/console/access` returns the exact RBAC permission. A missing facade is displayed as `UNKNOWN`, not treated as allow. Origin relay state comes from `/v3/console/origin-relays`; `sent` without a valid `sent_at` is displayed as `UNKNOWN`. Ultimate Terminal is an optional same-origin client plugin (`ultimate-terminal.client`), not an adapter or broker, and requires both `ultimate-terminal.connect` and `terminal.pty.client`.

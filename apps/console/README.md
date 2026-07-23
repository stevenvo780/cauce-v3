# Cauce V3 Console

React/Vite operator console in the canonical pnpm workspace. It consumes only gateway facades under `/v3/console/*` and `/v3/status`; it does not connect as a delivery consumer or own durable state.

The publish client allowlists `{room_id,recipients,body,lane,priority,idempotency_key}`. Actor, tenant, session, channel, request/trace and origin are server-derived. Production uses the gateway OIDC BFF: the UI navigates to `/v3/auth/login`, sends only the `__Host-` HttpOnly session cookie, and keeps the CSRF value in React/API-client memory. It never receives bearer/refresh tokens and never uses browser storage for credentials. Explicit demo builds may set `VITE_CAUCE_DEV_AUTH=1`, `VITE_CAUCE_DEV_TENANT` and `VITE_CAUCE_DEV_ALIAS`; never enable that build in production.

```sh
pnpm --filter @cauce/console dev
pnpm --filter @cauce/console lint
pnpm --filter @cauce/console typecheck
pnpm --filter @cauce/console test
pnpm --filter @cauce/console build
```

MSW exists only in `src/mocks` for unit/contract tests or `dev:mock`; normal dev/build uses the real gateway. Nginx proxies `/v3` and WebSocket to `gateway:8080` and serves the SPA with restrictive headers.

Mutating controls default closed unless `/v3/console/access` returns the exact RBAC permission. A missing facade is displayed as `UNKNOWN`, not treated as allow. Origin relay state comes from `/v3/console/origin-relays`; `sent` without a valid `sent_at` is displayed as `UNKNOWN`. Ultimate Terminal is an optional same-origin client plugin (`ultimate-terminal.client`), not an adapter or broker, and requires both `ultimate-terminal.connect` and `terminal.pty.client`.

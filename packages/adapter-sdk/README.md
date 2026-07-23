# `@cauce/adapter-sdk`

Durable consumers for Cauce V3 plus Hermes, OpenCode, Claude, Codex, OpenClaw and deterministic fake harness implementations.

## Boundary

The adapter uses the canonical `@cauce/protocol` V3 frames. It sends one long-lived hello with tenant, alias, instance and string capabilities; the authenticated transport must match that declaration. A delivery is persisted before execution and its ACK sequence is sent on the same socket:

`accepted → started → done|failed`

The local durable outbox keeps ACK events until the gateway returns an exactly correlated `ack_result`. Every delivery, lifecycle event and ACK carries `attempt` and `claim_token`; every event/ACK also carries `event_id`. Receipts are matched by all four values (`event_id`, `delivery_id`, `attempt`, `claim_token`) rather than FIFO order. Reconnect and redelivery reuse the same durable event IDs, while a confirmed terminal result is not published again.

A duplicate of the same attempt never executes twice. A higher attempt may execute only after the previous attempt ended in a retryable failure (including recovery's retryable `INTERRUPTED` result). A changed claim token for the same attempt and delayed receipts for older attempts cannot affect current work. Delivery fingerprint covers the immutable canonical message/body/authenticated-origin fields, so retries cannot change the payload.

## CLI and transport authentication

Build with `pnpm --filter @cauce/adapter-sdk build`. Binaries:

- `cauce-adapter-{hermes,opencode,claude,codex,openclaw,fake}`
- `cauce-fake-harness`
- `dist/bridge/hermes-stdin-bridge.py`
- `dist/bridge/openclaw-stdin-bridge.mjs`

The package exports both bridge paths as `@cauce/adapter-sdk/bridge/<name>` and
includes them in `npm pack`. A runtime image that copies this package's `dist/`
therefore carries the exact bridge files used by the definitions.

Required non-secret environment configuration is `CAUCE_TENANT`, `CAUCE_ALIAS`, `CAUCE_INSTANCE_ID`, `CAUCE_STATE_DIR`, and `CAUCE_RELAY_URL`. The secure default is `CAUCE_ENVIRONMENT=production`, which requires `wss://`.

- `CAUCE_TOKEN_FILE` supplies a gateway token or OIDC access token from an exactly `0600` file.
- mTLS requires all of `CAUCE_TLS_CERT_FILE`, `CAUCE_TLS_KEY_FILE`, and `CAUCE_TLS_CA_FILE`; each regular file must be exactly `0600`.
- Bearer and mTLS files are opened and validated again for every reconnect, supporting atomic credential rotation.
- `CAUCE_DEV_AUTH=1` adds identity headers only with `CAUCE_ENVIRONMENT=development|test`; production rejects it.
- URL userinfo, queries and fragments are rejected. Inline Cauce/OpenClaw secret environment variables are rejected.

Credentials never appear in URLs, argv, safe logs, or error messages. A local lease ensures that one stable alias cannot own two Cauce consumer sockets.

### Alias configuration file

Select one alias from a non-secret path configuration:

```sh
cauce-adapter-openclaw --config /etc/cauce/adapters.json --alias kant
```

```json
{
  "aliases": {
    "kant": {
      "tenant": "Steven",
      "instance_id": "openclaw-kant-1",
      "state_directory": "/var/lib/cauce/kant",
      "relay_url": "wss://gateway.example/v3/ws",
      "environment": "production",
      "token_file": "/run/cauce/gateway-token",
      "mtls": {
        "cert_file": "/run/cauce/client.crt",
        "key_file": "/run/cauce/client.key",
        "ca_file": "/run/cauce/ca.crt"
      },
      "openclaw": { "transport": "cli" }
    }
  }
}
```

The configuration stores credential paths, never values. Relative state/credential paths resolve from its directory. `CAUCE_CONFIG_FILE` can replace `--config`; `CAUCE_ALIAS` can replace `--alias`.

### OpenClaw

OpenClaw 2026.6.6 has neither `--message-file` nor a working
`/v1/chat/completions` endpoint. CLI mode therefore runs the packaged Node
bridge. It reads a maximum 1 MiB exclusively from stdin, discovers exactly one
compatible installed `dist/agent-via-gateway-*.js` and `dist/runtime-*.js`, and
calls `agentCliCommand({message, sessionKey, json: true, deliver: false},
defaultRuntime)`. Discovery fails closed on absence or ambiguity. Native stdout
is captured and only a JSON envelope is emitted; the bridge does not read or
use a token. The generated `--session-key` is the only legacy adapter argument
it extracts.

The default bridge is `dist/bridge/openclaw-stdin-bridge.mjs`. Override its
absolute path with `CAUCE_OPENCLAW_BRIDGE`. If package/PATH discovery is not
appropriate, set the non-secret `CAUCE_OPENCLAW_DIST_DIR` to the installed
OpenClaw `dist/` directory. `CAUCE_HARNESS_COMMAND` can override the Node
executable. The prompt and trusted origin context remain on stdin; timeout,
cancellation and shutdown terminate the complete bridge process group.

The older explicit API runner remains available only for independently verified
Gateway builds; it is not a fallback for OpenClaw 2026.6.6, whose endpoint was
observed returning 404. A legacy configuration has this shape:

```json
{
  "openclaw": {
    "transport": "api",
    "api_url": "http://127.0.0.1:18789/v1/chat/completions",
    "token_file": "/run/cauce/openclaw-token",
    "agent_target": "openclaw/default"
  }
}
```

API URLs are restricted to loopback HTTP(S), the exact `/v1/chat/completions` path, no redirects and no URL credentials/query/fragment. The `0600` bearer token reloads per request. A durable native session ID is sent as OpenAI `user`; cancellation and timeout abort HTTP. API mode requires both `api_url` and `token_file` paths.

### Hermes

Hermes 0.19 has no JSON/stdin one-shot CLI. The default command is the current
`python3` plus `dist/bridge/hermes-stdin-bridge.py`. The bridge reads at most
1 MiB from stdin, imports `hermes_cli.oneshot.run_oneshot` from that interpreter,
captures native stdout, and emits one JSON envelope. It ignores all argv and
never logs the prompt. Select a VENV interpreter with `CAUCE_HERMES_PYTHON` and
override the bridge with `CAUCE_HERMES_BRIDGE` (both are non-secret paths).
The operational inference model is selected by Hermes through
`HERMES_INFERENCE_MODEL`; the adapter manifest records that environment name,
not a provider or model value. Set it in the private runtime environment.

## Body mapping

A canonical delivery executes `body.prompt` or `body.text`; positive `body.timeout_ms` controls the harness deadline. `body.session_key` is never trusted or used. Persistent-session scope is namespaced and derived only from authenticated envelope facts: tenant, authenticated actor, origin channel, session and conversation. The normalized prompt includes trusted origin context. Structured output is placed under ACK `result.output`; origin relay remains server-side from the message's authenticated origin.

The package tests use executable doubles for all six definitions plus a fake OpenClaw loopback API. They cover success, failure, retries, lifecycle/ACK correlation, stale claims, malformed output, timeout, cancellation, process-tree cleanup, durable recovery/redelivery, origin context, authenticated alias/session isolation, credential permissions/redaction/rotation, WSS enforcement and manifest parity. A real smoke is limited to `openclaw --version`/`--help` when installed; tests never submit a real prompt.

Captured compatibility fixtures cover OpenCode 1.17.7 (`step_start`, `text`,
`step_finish`) and Codex 0.144.6 (`thread.started`, `item.completed`,
`turn.completed`). Final native text is parsed as structured JSON when valid;
otherwise non-empty plain text up to 64 KiB becomes a safe done reply. An
object-like malformed/schema-invalid JSON result is never hidden by fallback.

Package smoke: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm smoke:package`.

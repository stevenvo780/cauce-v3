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

### Historical OpenCode compatibility for Kant

Kant has used the Codex harness in the live fleet since the 2026-07-23 cutover.
The OpenCode adapter remains packaged only for rollback compatibility. Its
historical persistent-server invocation is:
`opencode run --format json --attach http://127.0.0.1:4097 --dir /workspace/kant`.
The first delivery omits `--session`, observes the native `sessionID` in OpenCode
1.17.7 JSONL, and persists it; later deliveries append `--session <observed-id>`.
The server lifecycle remains external to the SDK. Do not start or probe it on
the live Codex path; those steps apply only after a successful CAS rollback to
the historical Kant release.

Only the exact pair `harness=opencode`, `alias=kant` publishes
`$CAUCE_STATE_DIR/canonical-opencode-session.json`. The version-1 document is
owner-only (`0600` in the SDK's `0700` state directory) and contains only
`version`, `state`, `alias`, `harness`, `scope_key`, `session_id`, plus `reason`
when unavailable. `scope_key` is the existing `auth-v1:` SHA-256 scope token;
raw prompt, chat, user and message identifiers are never copied into the file.
An active document requires a native ID matching
`ses_[A-Za-z0-9_-]{4,124}`. The mapping
`opencode:kant:<scope_key>` is fsynced and atomically renamed before the pointer
is atomically published.

At adapter startup, zero initialized mappings produces
`state=unavailable, reason=missing`; one valid mapping produces `state=active`;
more than one produces `state=unavailable, reason=ambiguous`. One malformed
mapping produces `reason=invalid`. A missing or stale pointer is reconstructed
only from exactly one valid initialized mapping. During one process lifetime the
first successfully persisted scope is sticky: that scope refreshes the pointer,
while a later scope can persist its own mapping but cannot replace it. Non-zero
execution, malformed output, missing native ID or an invalid native ID never
publishes an active pointer.

For this exact Kant/OpenCode path, the initial `DurableStore.open()` defers
`sessions.json`; `AdapterClient` acquires the stable-alias lease and only then
reloads and reconciles it. The reload opens the leaf with
`O_NOFOLLOW|O_NONBLOCK`, uses descriptor metadata (`fstat`) to require a regular,
single-link, current-owner `0600` file no larger than 1 MiB, detects concurrent
changes, rejects duplicate JSON keys and validates an exact bounded schema. A
missing file is the valid zero-mapping state. Any malformed/schema/permission/
type/size failure first atomically replaces a stale pointer with
`unavailable/invalid`, then aborts adapter startup before transport connect.

Every durable rename fsyncs its directory. Only the explicit unsupported
filesystem codes `EINVAL`, `ENOTSUP` and `EOPNOTSUPP` are tolerated; `EIO` and
all other errors propagate. Before replacing an existing target, the writer
creates a separate owner-only `0600` backup in the same directory, copies the
prior bytes without changing the target's link count, and fsyncs both backup and
directory before publishing the backup name. A post-rename fsync failure atomically restores that copied backup (or
removes a first publication) and fsyncs the rollback before the error escapes.
After a successful target fsync the backup is renamed to a committed marker;
startup restores an uncommitted backup, keeps the target for a committed marker,
removes incomplete backup staging and orphan pre-rename temporaries, and rejects
ambiguous/legacy artifacts.

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

A canonical delivery executes `body.prompt` or `body.text`; positive
`body.timeout_ms` can shorten the harness deadline but can never extend it
beyond the authenticated delivery's fixed `ack_deadline_at`. The engine keeps
an adaptive 10% completion margin, capped at 30 seconds, for process
termination, durable state and the terminal ACK; this budget also covers time
spent waiting for a serialized native session. `body.session_key` is never
trusted or used. Persistent-session scope is namespaced and derived only from
authenticated envelope facts: tenant, authenticated actor, origin channel,
session and conversation. The normalized prompt includes trusted origin
context. Structured output is placed under ACK `result.output`; origin relay
remains server-side from the message's authenticated origin.

The normalized prompt also includes the trusted top-level `routing_targets`
inventory. Models must not recall aliases from conversation history. A request
for all other agents is represented by one durable message to the reserved
`@all` target; the store expands it to the online routable peers other than the
current alias. Every bundled adapter announces `routing_targets_v1` in its
hello capabilities so a rolling gateway sends the optional inventory only to
compatible leases.

For internal `agent.message` and `agent.response` deliveries, `reply` is the
return path to the sender and `messages` contains only genuinely new
delegations to other targets. The SDK rejects any message addressed back to the
sender. A successful result without delegations requires a non-empty `reply`;
`reply:null` remains valid while at least one new message is emitted.
`agent.fanin` is terminal aggregation: it requires one non-empty synthesized
reply and forbids another delegation round, including on failed outputs.

Direct delegation targets must be canonical aliases that map to exactly one
online entry in the trusted inventory; self, sender, offline, unknown and
cross-tenant ambiguous aliases fail closed. The reserved `@all` target must be
the only message, is permitted only for non-internal requests, and requires at
least one online peer. Failed outputs cannot contain messages because the store
does not materialize them.

Replies and message bodies must contain a Unicode-visible code point: strings
made only of Unicode `White_Space`, format controls (`Cf`), control characters
(`Cc`, including NUL), non-spacing marks (`Mn`) or enclosing marks (`Me`) are
rejected. Plain-text fallback applies the same rule without changing the 64 KiB
byte limit.

Each relayed message body is limited to 64 KiB of UTF-8, all unexpanded bodies
in one result are limited to 256 KiB, and one `@all` expansion is limited to
512 KiB across its online recipients. A result may contain at most 100
messages.

An `agent.fanin` delivery ignores `body.text` and requires the structured object
`body.fanin_data_v1` with schema `cauce.agent_fanin_data.v1`. The SDK renders
the ordered attributed responses with a pure deterministic synthesizer and
never invokes a provider harness, tool or native session for this delivery
type. The synthesizer itself has no network or filesystem operations. Nested
`untrusted_text` is copied as data, never executed or interpreted as
instructions, every response requires canonical `tenant_id` and `alias`, and
the final visible reply attributes it as `tenant_id/alias` within a 64 KiB
UTF-8 bound. When this adapter already processed correlated child responses,
their terminal local replies are rendered in a separately budgeted attributed
section; the raw Store responses remain visible in their own section. Each
entry receives a deterministic byte share and an explicit truncation marker,
so a large local reply cannot hide another branch.

For an authenticated `agent.response`, the SDK recovers the original request
only when local durable state proves the exact delegation lineage
(`source.output.messages -> actor_alias`, trace, recipient and root
correlation). Stateless harnesses therefore receive both the authoritative
original task and the returned child text marked as untrusted evidence.
Retained lineage requests are removed atomically when fan-in completes and are
also pruned by an unreferenced timer after 24 hours, including while the
adapter is otherwise idle.

`agent.message`, `agent.response` and `agent.fanin` are reserved internal body
types. Store is the provenance trust boundary that must reject these types on
public publish and create them only from durable materialization state. The SDK
intentionally does not treat body-controlled markers such as
`fanin_data_v1.trust` as authentication; once Store emits a claimed fan-in, the
SDK still validates its complete renderable shape before deterministic
synthesis.

The package tests use executable doubles for all six definitions plus a fake OpenClaw loopback API. They cover success, failure, retries, lifecycle/ACK correlation, stale claims, malformed output, timeout, cancellation, process-tree cleanup, durable recovery/redelivery, origin context, authenticated alias/session isolation, credential permissions/redaction/rotation, WSS enforcement and manifest parity. A real smoke is limited to `openclaw --version`/`--help` when installed; tests never submit a real prompt.

Captured compatibility fixtures cover OpenCode 1.17.7 (`step_start`, `text`,
`step_finish`) and Codex 0.144.6 (`thread.started`, `item.completed`,
`turn.completed`). Final native text is parsed as structured JSON when valid;
otherwise non-empty plain text up to 64 KiB becomes a safe done reply. An
object-like malformed/schema-invalid JSON result is never hidden by fallback.

Package smoke: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm smoke:package`.

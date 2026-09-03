# Terminal relay configuration

`terminal-relay` is the data plane of the console terminals: it moves bytes between the
browser and a PTY agent and holds no authority of its own. Every allow/deny decision — ticket
validity, continued authorization, session close — is an HTTPS round trip to the gateway. It
keeps no state on disk, has no database, no `node-pty` and no Docker socket, so restarting it
kills terminals and touches nothing else in the bus. That separation is the reason it exists:
restarting the gateway kills adapters with work in flight, restarting this does not.

## Topology

The core (gateway, dispatcher, console, PostgreSQL) runs on `agora-storage`; the agent
containers run on `kratos`. The relay lives with the core and the crossing is made **by the
agents, outbound**:

- **Browser leg** — WebSocket over TLS on `8446`, compose-internal. The console nginx
  terminates the operator connection and re-dials with a client certificate; the browser never
  reaches this listener. The certificate is verified against `CLIENT_CA` and its CN must be in
  `CONSOLE_CN`.
- **Agent leg** — raw TLS (not WebSocket) on `8445`, published on the private tailnet address.
  PTY agents inside containers on `kratos` dial **out** to it. The relay never dials into
  `kratos`: no such route exists and creating one would be a privilege escalation.
- **Gateway client** — HTTPS to `CAUCE_TERMINAL_GATEWAY_URL` with a bearer token read from
  `TOKEN_FILE` on every call, so rotating the token needs no restart. A gateway behind a
  private CA is trusted through `NODE_EXTRA_CA_CERTS`; the relay adds no CA setting of its own.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAUCE_TERMINAL_RELAY_BROWSER_PORT` | `8446` | WebSocket listener for the console nginx. |
| `CAUCE_TERMINAL_RELAY_AGENT_PORT` | `8445` | Raw TLS listener for PTY agents. |
| `CAUCE_TERMINAL_RELAY_HEALTH_PORT` | `8085` | HTTP listener serving `/health/live`, `/health/ready` and `/metrics`. Bound on every interface of the compose network, exactly like the dispatcher's: Prometheus is a separate container and a loopback bind is a target it can never reach. Compose publishes no host port for it, so it is reachable only from inside the network. |
| `CAUCE_TERMINAL_RELAY_TLS_CERT_FILE` | — | Server certificate for both listeners. |
| `CAUCE_TERMINAL_RELAY_TLS_KEY_FILE` | — | Server private key. |
| `CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE` | — | CA of the console nginx client certificate. |
| `CAUCE_TERMINAL_RELAY_CONSOLE_CN` | `console` | Comma-separated, unique allowlist of safe console CNs (for example `console-client,gateway-client`). Empty elements, controls and duplicates fail startup. |
| `CAUCE_TERMINAL_RELAY_AGENT_CA_FILE` | — | CA of the PTY agent client certificates. |
| `CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE` | `/run/cauce-terminal/pty_agent_identities.json` | Fingerprint registry, re-read on every handshake. |
| `CAUCE_TERMINAL_GATEWAY_URL` | `https://gateway:8443` | Credential-free HTTPS origin of the gateway. |
| `CAUCE_TERMINAL_RELAY_TOKEN_FILE` | — | File holding the gateway bearer token. |
| `CAUCE_TERMINAL_IDLE_TIMEOUT_SECONDS` | `600` | Shell: no human input. Read-only harness: no browser heartbeat and no PTY output. Closes with 4408. |
| `CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC` | `262144` | Sustained output allowance per session. |
| `CAUCE_TERMINAL_SCROLLBACK_BYTES` | `20480` | Bounded in-memory output tail per session. It is not, by itself, a reconnect mechanism; see below. |
| `CAUCE_TERMINAL_MAX_SESSIONS` | `16` | Concurrent terminals in the process. |
| `CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS` | `30` | Revalidation period of a live session. |
| `CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS` | `90` | How long an unreachable gateway is tolerated. |
| `CAUCE_TERMINAL_RECONNECT_GRACE_SECONDS` | `30` | Maximum browser-loss window in which the same live PTY may be reattached. |
| `CAUCE_TERMINAL_CLOSE_SPOOL_FILE` | `/tmp/cauce-terminal-close-reports.json` | Atomic local retry spool for close reports; contains only session ids, reasons and counters. |
| `CAUCE_TERMINAL_RECORDING_DIR` | — | Absolute path of the `0700` directory holding one `0600` asciicast v2 file per session. **Unset means no writable TUI**: `harness_rw` is refused. |
| `CAUCE_TERMINAL_RECORDING_MAX_BYTES` | `33554432` | Per-session recording cap. On reaching it the recording stops with a marker event; the session keeps running and the close report says `recording_capped`. |
| `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS` | `0` | Extends recording to plain interactive `shell` sessions. **Off by default**: recording is tied to the writable TUI, and an operator's ordinary shell keystrokes (a pasted token, a `psql` password) are not persisted unless the owner asks for it. `1` turns it on; it needs `CAUCE_TERMINAL_RECORDING_DIR` too, and a `shell` whose recording cannot be opened is still allowed to run (unlike `harness_rw`, which is refused). |

Setting `CAUCE_TERMINAL_RECORDING_DIR` is a **coupled** rollout: a recorded session's close
report carries `input_batches`, `recording_sha256` and `recording_capped`, and the gateway
validates that body against an exact key set. Turn the directory on only against a gateway that
accepts the three fields, or every recorded close will be refused and retried forever. Without
the directory the report is byte for byte what it was, so the relay can be deployed first on its
own.

`recording_capped` is what keeps a capped recording from reading as a complete one. Once the
per-session byte cap is reached the file stops growing and `input_batches` freezes with it, while
`bytes_in` keeps counting — at the default output rate the 32 MiB cap is about two minutes of
sustained output. The flag travels next to the digest so the aggregate `terminal.session.input`
audit row states plainly that the sha256 attests to a truncated file. Retention is **not** solved
here: nothing prunes the directory, and how long a recording is kept, on which volume and who
deletes it is an owner decision, not a default.

## Metrics

`/metrics` is served by the same listener as the health probes, in Prometheus text
format, and is scraped by the `cauce-relay` job of `ops/observability/prometheus.yaml`, which
discovers the relay by DNS: `terminal-relay` is `profiles: [terminal]`, so on a stack without the
PTY channel the name does not resolve, no target exists, and the `cauce-v3-terminal` rules — none
of which uses `absent()` — stay silent instead of paging two agents forever. Every
series is aggregate: there is no tenant, alias, operator, container or session label anywhere,
because the shape of who is being watched must not leak into a scrape target that has no
authorization of its own. The close-code label is bounded to the codes the relay itself emits;
anything else folds into `code="other"` so a peer cannot mint series.

| Series | Type | Meaning |
| --- | --- | --- |
| `cauce_terminal_sessions_open{mode}` | gauge | Attached sessions by mode. |
| `cauce_terminal_control_sessions_open` | gauge | Attached writable TUI sessions. |
| `cauce_terminal_session_opens_total{result}` | counter | `opened`, `denied`, `fenced`, `expired`. |
| `cauce_terminal_bytes_in_total` / `cauce_terminal_bytes_out_total` | counter | Bytes each way; `out` includes the forwarded agent notices. |
| `cauce_terminal_close_codes_total{code}` | counter | Closes by WebSocket close code. |
| `cauce_terminal_recordings_total{result}` | counter | `started`, `refused`, `capped`, `failed`. |
| `cauce_terminal_presence_last_success_timestamp_seconds` | gauge | `-1` before the first accepted publication. |
| `cauce_terminal_ready` | gauge | Same verdict as `/health/ready`. |

The `result` label name comes from `renderCounters` in `@cauce/protocol`, which every service
in the bus shares; the alert rules in `ops/observability/alerts.yaml` use it as written here.

One deployment detail still stands between the job and the data: in `deploy/compose.yaml` the
relay is attached to `edge` and Prometheus to `backend`, so the DNS name does not resolve for the
scraper and the job discovers nothing. Adding `backend` to the relay's `networks` is what turns
the job on; until then the wiring is correct and silent, which is the intended failure mode.

## Agent identity

Mutual TLS admits nobody by itself. The SHA-256 fingerprint of the verified peer certificate
must also appear in the registry, with a `tenant_id`/`alias` matching the `AGENT_HELLO` and a
future `expires_at`:

```json
{"version":1,"agents":[
  {"fingerprint_sha256":"AA:BB:…","tenant_id":"Steven","alias":"jarvis","expires_at":"2026-10-23T00:00:00Z"}
]}
```

The file is read on every handshake and is expected to be rotated by atomic rename. A missing,
unreadable or malformed file admits **no** agent — revocation is a file write, not a restart.
An agent that claims an alias its certificate does not own gets `HELLO_ACK {ok:false}` and is
disconnected.

## Limits and fail-closed behaviour

Every live session is revalidated against `/v3/terminal/relay/sessions/<sid>/authz`. A `403`
closes it with 4403 immediately; a gateway that stays unreachable longer than the grace window
closes it too. A session is never grandfathered because its authorization could not be
re-confirmed. Idle closes with 4408, the granted TTL with 4423, and sustained output above the
rate limit produces a warning notice and then closes with 4413 — a `cat` of a binary cannot
take the service down.

Input and output pressure are scoped to one session:

- Browser `input` messages are limited to 16 KiB each and to 64 KiB while the 8 ms keystroke
  coalescer is pending. Frames arriving before the agent finishes `OPEN` are capped at 128 KiB.
  Exceeding a bound closes that session with 4414. Relay-to-agent writes follow Node's
  `write()`/`drain` contract and have a 512 KiB bounded queue; the Python agent then drains to
  the non-blocking PTY with `select`, with a final 256 KiB per-session input high-water mark.
- When one browser's `bufferedAmount` exceeds 4 MiB, the relay sends `PAUSE_OUTPUT` for that
  session only and resumes it below 1 MiB. The agent keeps reading its multiplexed TLS socket,
  so PONG and every other terminal continue to flow. This is negotiated through the
  `session_output_flow_control` feature. An older agent that did not advertise it causes only
  the slow browser session to close with 4415; the shared agent socket is never paused.

For idle accounting, human input is the only activity that extends an interactive `shell`.
A read-only `harness` cannot produce human input, so either real PTY output or the console's
typed `ping` heartbeat proves that the viewer is still present. The heartbeat is control only:
it never becomes STDIN.

### The three modes

`READ_ONLY_MODES` is exactly `{harness}` and gates STDIN; `TUI_MODES` is `{harness,
harness_rw}`, the set allowed to answer DA/DSR; `WRITABLE_MODES` is `{shell, harness_rw}`. What
pins the relay's copy is behaviour, not a data file: they live in `src/session-limits.ts` and are
held by the assertions in `src/sessions.test.ts` and `src/sessions-writable.test.ts` — widen one
and those suites go red. `tests/terminal-pty/vectors.json` freezes the **Python agent's**
frozensets, and the four implementations must agree with each other.

`harness_rw` is a writable TUI: it types on the alias's real tmux pane. Three rules hold it:

- **Recording is a precondition, not a feature.** Without a writable
  `CAUCE_TERMINAL_RECORDING_DIR` the open is refused with `recording_unavailable` (`1011`)
  before the PTY exists, and a write failure mid-session closes it with `recording_failed`. A
  writable mode nobody can replay afterwards is not a mode. The recording holds the bytes; the
  close report and every audit row carry only counts, the sha256 and the `recording_capped` flag.
  A read-only mode is never recorded — it has no keyboard to record — and a plain `shell` only
  behind `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS`.
- **Idle is NOT rearmed by output, and not by the browser `ping` either.** Only typing extends
  it, plus the operator's explicit `POST .../extend`. A read-only viewer has no keyboard, which
  is why output and ping rearm *its* idle; a writable session does have one, and a forgotten tab
  in front of a chatty process would otherwise live forever.
- **The control hold is re-checked by the same 30 s `/authz` cycle as everything else.** When
  the gateway reports the hold is gone, the session closes with `4410 control_released`.

The agent may also send two informational frames the relay forwards untouched to the browser:
`INPUT_REFUSED` (`0x26`, a paste or governance write holds the pane) and `GEOMETRY` (`0x27`, the
remote TUI's real size). Neither closes the session, and the relay does not interpret either —
it only stamps the frame's discriminator last so a hostile agent cannot rename it. It does,
however, **account** them: the serialized frame counts against the same output window and goes
through the same backpressure check as PTY output, so a compromised agent looping `GEOMETRY`
trips 4413 or 4415 exactly like a `cat` of a binary. They are deliberately kept out of the resume
offset, which addresses the binary stream the browser counts. A notice that arrives before the
browser has been sent `ready` is held in a bounded queue and delivered right behind it, never
ahead of it.

Close codes: `4400` protocol error, `4401` ticket invalid, `4403` revoked, `4404` agent
offline, `4408` idle, `4409` session conflict, `4410` control released, `4413` output flood,
`4414` input flood, `4415` slow browser or blocked technical-response path, `4423` TTL expired,
`1011` internal error, `1001` relay shutdown.

## Reconnect contract and threat model

The one-shot OPEN ticket still cannot be replayed. After the gateway consumes it, it returns an
HMAC capability in a different HKDF domain, bound to the exact session id, operator id and
consumed-session expiry. The credential stays in browser memory, crosses only the console TLS
WebSocket and the mutually authenticated relay-to-gateway path, and is never persisted or logged.

An abnormal browser loss detaches only that socket for the bounded reconnect grace. Resume always
re-reads the database row, routing authority, complete physical-container grant set, revocation,
close state and TTL. It can only call `SessionManager.reattach`: it has no code path to `OPEN` and
therefore cannot create a PTY. Reattach succeeds only while the prior browser socket is absent;
two concurrent replays race on the single relay event loop and exactly one becomes owner. Output
is replayed from the bounded offset-addressed tail and the pty-agent receives only a resize.

The capability is reusable inside that short grace rather than rotated: the gateway keeps no
browser credential state, and pretending to rotate a stateless token would leave the previous
token valid. Its replay surface is bounded by all of the following independent gates: trusted
browser Origin at nginx/relay, console client-certificate CN, relay bearer plus gateway mTLS,
live authorization, original session TTL, one live `TerminalSession`, and one attached socket.
An explicit browser close, grace expiry, agent loss or authorization failure kills the PTY and
durably queues the close report. Rotation would require a persisted nonce hash and atomic consume;
it must not be claimed until that state exists.

A `harness_rw` session widens what a compromised console can do from *watching* an alias to
*typing at* it, so it is fenced by more than the reconnect contract: the gateway grants the mode
only to an attributed operator with an explicit grant (no `"*"` row satisfies it), the relay
refuses to open it without a recording, and the recording is the only durable copy of what was
typed. The recording directory therefore inherits the threat profile of the PTY stream itself:
`0700` directory, `0600` files, opened `O_EXCL` so two writers can never interleave into one
file, and never exposed over any listener the relay serves.

## Hygiene

Run as a non-privileged user in a `read_only` container with `cap_drop: ALL`; the process
refuses to start with exit code 78 if its euid is 0. Logs carry alias, session id, counters,
close codes and fingerprints truncated to 16 hex — never tickets, PTY bytes, tokens or
certificate material. `SIGTERM` closes every session with 1001, flushes the close reports to
the gateway and exits.

## Tests

`pnpm --filter @cauce/terminal-relay test` covers the framing golden vector shared with the
Python agent, byte-at-a-time reassembly, per-session flow control, bounded `write()`/`drain`,
slow and concurrent browsers, viewer presence, continuous output, input floods, and a circuit
test that stands up both mutual-TLS listeners with throwaway fixtures and drives attach, echo,
revocation, agent absent, flood and fail-closed paths.

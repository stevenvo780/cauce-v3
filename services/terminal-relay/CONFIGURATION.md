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
| `CAUCE_TERMINAL_RELAY_TLS_CERT_FILE` | — | Server certificate for both listeners. |
| `CAUCE_TERMINAL_RELAY_TLS_KEY_FILE` | — | Server private key. |
| `CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE` | — | CA of the console nginx client certificate. |
| `CAUCE_TERMINAL_RELAY_CONSOLE_CN` | `console` | Comma-separated allowlist of console CNs. |
| `CAUCE_TERMINAL_RELAY_AGENT_CA_FILE` | — | CA of the PTY agent client certificates. |
| `CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE` | `/run/cauce-terminal/pty_agent_identities.json` | Fingerprint registry, re-read on every handshake. |
| `CAUCE_TERMINAL_GATEWAY_URL` | `https://gateway:8443` | Credential-free HTTPS origin of the gateway. |
| `CAUCE_TERMINAL_RELAY_TOKEN_FILE` | — | File holding the gateway bearer token. |
| `CAUCE_TERMINAL_IDLE_TIMEOUT_SECONDS` | `600` | No browser input for this long closes with 4408. |
| `CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC` | `262144` | Sustained output allowance per session. |
| `CAUCE_TERMINAL_SCROLLBACK_BYTES` | `20480` | Replay buffer kept per session for a reattach. |
| `CAUCE_TERMINAL_MAX_SESSIONS` | `16` | Concurrent terminals in the process. |
| `CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS` | `30` | Revalidation period of a live session. |
| `CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS` | `90` | How long an unreachable gateway is tolerated. |

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
take the service down. When `bufferedAmount` on the browser socket exceeds 4 MB the agent
socket is paused until it drains.

Close codes: `4400` protocol error, `4401` ticket invalid, `4403` revoked, `4404` agent
offline, `4408` idle, `4409` session conflict, `4413` output flood, `4423` TTL expired, `1011`
internal error, `1001` relay shutdown.

## Hygiene

Run as a non-privileged user in a `read_only` container with `cap_drop: ALL`; the process
refuses to start with exit code 78 if its euid is 0. Logs carry alias, session id, counters,
close codes and fingerprints truncated to 16 hex — never tickets, PTY bytes, tokens or
certificate material. `SIGTERM` closes every session with 1001, flushes the close reports to
the gateway and exits.

## Tests

`pnpm --filter @cauce/terminal-relay test` covers the framing golden vector shared with the
Python agent, byte-at-a-time reassembly, the session limits, and a circuit test that stands up
both mutual-TLS listeners with throwaway fixtures and drives attach, echo, revocation, agent
absent, flood and fail-closed paths.

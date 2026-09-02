# PTY channel interoperability harness (wire contract v1)

Three teams implement the same protocol separately and without seeing each other:

| Piece | Language | Role |
|---|---|---|
| `gateway` | TypeScript | issues and redeems tickets, decides authorization, writes the audit |
| `terminal-relay` | TypeScript | multiplexes bytes between the browser (WebSocket) and the agent (raw TLS) |
| `pty-agent` | Python 3, standard library only | opens the PTY inside the target container, on another host (kratos) |

The core (gateway, dispatcher, console) lives in `agora-storage`; the agent containers
live in `kratos`. Every terminal session crosses that boundary, so the only place
where all three implementations meet is this directory. **If these tests do not
pass, the PTY channel is not deployed.**

This harness does not depend on the code of any of the three: it implements the
contract a fourth time (`protocol.mjs`) using only native Node modules and compares
against frozen golden vectors.

## How to run

```bash
# entire harness (this is what integration verification runs)
pnpm vitest run tests/terminal-pty

# only the golden vectors: ticket + framing byte-by-byte
pnpm vitest run tests/terminal-pty/vectors.test.ts

# only the circuit: fake gateway + fake agent (+ real relay if merged)
pnpm vitest run tests/terminal-pty/relay-contract.test.ts
```

`pnpm vitest run tests/terminal-pty` works with the vitest config as it is at the
root (no need to touch `vitest.config.ts`: the default include already covers
`**/*.test.ts`). There is intentionally no script in `package.json` for this —
the root `package.json` belongs to another module; the integrator may add
`"test:terminal-pty": "vitest run tests/terminal-pty"` if they want it in the
general battery.

Requirements: Node >= 22, `vitest` and `ws` (already in the lockfile) and
`openssl` on PATH, used to mint self-signed certificates in a temp directory at
test time. No new dependencies; `pnpm-lock.yaml` is not touched.

## What each piece tests

### `vectors.json` — the source of truth

The file is one JSON object, not a bare array: `contract`, `frozen`, `note`, `master_key_b64`,
`hkdf` (hash/salt/info template/length), `framing` (header shape, max payload, the tag numbers),
`ws_close_codes`, `keys` (per-`tenant:alias` derived key, precomputed) and `cases` — the frozen
vectors themselves. Each case is `{name, kind, input, expected, must_fail}`.
The first three come from the spec (derived key, full ticket, and STDOUT frame);
the rest were generated with the same algorithm to cover edges: expired ticket,
ticket that has not yet started, one bit flipped in the HMAC, payload mutated to
`uid:0` while keeping the signature, ticket signed with another alias's key,
target of another alias, target of another tenant, zero-length frames, max-length
frame (65536), a frame split into 1-byte chunks, two frames in a single read plus
an incomplete third, an unknown tag, and a length declared above the max.

The `kind`s understood by the runner: `derive_alias_key`, `canonical_payload`,
`mint_ticket`, `verify_ticket`, `encode_frame`, `decode_frame`, `decode_stream`.

**Do not recompute them.** If your implementation does not reproduce a vector,
yours is wrong. Any change here is a contract change and is announced to all
three teams.

For the other two implementations the file is directly consumable — read the whole object, then
index into `cases`:

```python
# pty-agent (Python): same file, same expected result
import json, hashlib, hmac
vectors = json.load(open("tests/terminal-pty/vectors.json"))
cases = vectors["cases"]
```

### `vectors.test.ts` — detects protocol divergence

Walks every case and additionally recomputes the three golden values **without
using `protocol.mjs`**, directly with `node:crypto`, so an error in the harness
itself does not self-confirm. It also verifies the vectors file is still the
frozen one (if someone "improves" it, the test says so) and that every byte from
0x00 to 0xff survives a round trip through a STDIN frame without transcoding.

### `fake-pty-agent.mjs` — the agent leg, without kratos

Standalone Node executable that speaks like the Python agent against a real
relay: sends `AGENT_HELLO`, replies `PONG` to `PING`, **verifies each `OPEN`
ticket with the same rules as the real agent** (signature, window, sid, tenant,
alias, container, generation, mode) and instead of opening a PTY emulates a
trivial shell.

```bash
RELAY_HOST=127.0.0.1 RELAY_PORT=8600 \
TENANT=Steven ALIAS=jarvis ALIAS_KEY_HEX=<64 hex> \
AGENT_CERT=/tmp/agent.pem AGENT_KEY=/tmp/agent.key AGENT_CA=/tmp/ca.pem \
CONTAINER_ID=claw GENERATION=gen-1 IMAGE_ID=sha256:... RUNTIME_USER=claw RUNTIME_UID=1000 \
node tests/terminal-pty/fake-pty-agent.mjs
```

Emulated shell commands: echo of everything that arrives; `ping` -> `pong-<n>`;
`size` -> `size:<cols>x<rows>`; `id -un` -> the configured user; `hostname` ->
the container; `flood` -> `AGENT_FLOOD_BYTES` bytes at once (to trigger the
throughput cut, 4413); `exit` -> closes the session; Ctrl-C (0x03) -> `^C`.

Variables: `RELAY_HOST`, `RELAY_PORT`, `RELAY_SERVERNAME`, `AGENT_CERT`,
`AGENT_KEY`, `AGENT_CA`, `AGENT_TLS_INSECURE=1`, `TENANT`, `ALIAS`, `ALIAS_KEY_HEX`,
`CONTAINER_ID`, `GENERATION`, `IMAGE_ID`, `RUNTIME_USER`, `RUNTIME_UID`,
`AGENT_MODES`, `AGENT_BANNER=1`, `AGENT_ONESHOT=1`, `AGENT_FLOOD_BYTES`,
`AGENT_QUIET=1`, `AGENT_SIMULATE_EUID`.

Exit codes, identical to the real agent: `0` clean, `2` invalid configuration,
`3` HELLO rejected, `4` protocol error (unknown tag, out-of-size frame), `5`
transport error, **`78` refuses to run as root** (`AGENT_SIMULATE_EUID=0`
reproduces the case without needing to be root; there is a test that covers it).
Also, a signed ticket whose target says `uid: 0` is answered with
`OPEN_ERR reason=refuses_root`: the PTY never runs as root even if the gateway
signs it.

It never prints tickets or keys: only names, lengths, and a 12-hex `ticket_fp`.

### `fake-gateway.mjs` — the five endpoints, no database

Standalone HTTPS server (or HTTP with `GATEWAY_PLAINTEXT=1`) that implements:

| Endpoint | Behaviour |
|---|---|
| `POST /v3/terminal/relay/agents` | 200 if the alias is in grants, 403 `not_granted` if not |
| `POST /v3/terminal/relay/sessions/:sid/consume` | single-use atomic redemption: **200 the first time, 409 `ticket_already_consumed` the second**; 401 `ticket_invalid` with the reason; 403 `attribution_required` if an `unattributed:*` ticket points to another tenant |
| `POST /v3/terminal/relay/sessions/:sid/resume` | revalidates continuity after a relay reconnect: body carries `resume_token` plus the relay's own `claim_token`/`claim_epoch`; 401 `resume_invalid`, 403 `revoked`, 409 `claim_conflict` if another relay instance still holds a live claim, else 200 with a fresh claim lease |
| `POST /v3/terminal/relay/sessions/:sid/authz` | body carries `claim_token`/`claim_epoch`; 200 while that claim is live and matches the requesting relay instance; 403 with `reason` = `revoked` / `ttl_expired` / `unknown_session` / `closed` / `claim_fenced` |
| `POST /v3/terminal/relay/sessions/:sid/close` | 200 and `terminal.session.close` audit row |

All require `Authorization: Bearer <RELAY_TOKEN>`. Writes the audit rows that
the console's `/audit` screen must show (`terminal.session.request`,
`terminal.session.consume`, `terminal.session.close`) with alias, container,
image digest, generation, and the reason written by hand; the ticket never goes
in, only its fingerprint.

```bash
GATEWAY_PORT=0 RELAY_TOKEN=... MASTER_KEY_B64=... REVOKE_AFTER_MS=1500 \
node tests/terminal-pty/fake-gateway.mjs
# prints one JSON line: {"ready":true,"url":"https://127.0.0.1:PORT","port":PORT,"ca_path":"..."}
```

Variables: `GATEWAY_PORT`, `RELAY_TOKEN`, `MASTER_KEY_B64`, `OPERATOR_TENANT`,
`GRANTS` (`tenant:alias` list, comma separated), `REVOKE_AFTER_MS` (forces the
403 hot to verify the relay closes with 4403), `DOWN_AFTER_MS` + `DOWN_MODE`
(`reset` | `timeout` | `503`, for the fail-closed when the gateway is
unreachable), `GATEWAY_CERT`/`GATEWAY_KEY`, `GATEWAY_PLAINTEXT=1`.

As a library it exposes `startFakeGateway()` with `setGrants([])` (empties
`grants.json`), `revokeAll()`, `goDown()`, `restore()`, `audit`, and
`auditOf(event)`.

### `relay-contract.test.ts` — the circuit

Two halves:

1. **Always runs**: the fake gateway and the fake agent verify each other and
   against the contract. Single redemption (200 -> 409), forged, expired and
   cross-sid tickets, `attribution_required` for another tenant, hot revocation,
   emptied `grants.json`, full audit, downed gateway; and on the agent side:
   HELLO/ACK, PING/PONG, valid open, byte-by-byte echo, `pong-<n>`, Ctrl-C,
   RESIZE, readonly mode, rejection of another alias's ticket, expired, repeated
   sid (`session_conflict`) and root target, close with `CLOSED`, abort on
   unknown tag, and exit codes 78 and 2.
2. **Only runs with the real relay merged**: valid attach -> `ready` and echo;
   attach without ticket -> 4401; first frame that is not attach -> 4400; no
   agent connected -> 4404; hot revocation -> 4403; gateway unreachable past
   grace -> fail-closed close; mass output -> 4413; strict binary/text
   separation towards the browser. While `services/terminal-relay` does not
   exist, those seven cases are skipped and the `terminal-relay availability`
   test prints the exact reason.

To point it at a relay that is not yet in its canonical path:

```bash
CAUCE_TERMINAL_RELAY_ENTRY=services/terminal-relay/src/main.ts pnpm vitest run tests/terminal-pty
```

Environment contract the suite passes to the relay (if the M4 module uses other
names, adjust here, this is the only place that mentions them):
`CAUCE_TERMINAL_RELAY_WS_PORT`, `CAUCE_TERMINAL_RELAY_AGENT_PORT`,
`CAUCE_TERMINAL_RELAY_AGENT_TLS_CERT`, `CAUCE_TERMINAL_RELAY_AGENT_TLS_KEY`,
`CAUCE_TERMINAL_RELAY_GATEWAY_URL`, `CAUCE_TERMINAL_RELAY_GATEWAY_TOKEN`,
`CAUCE_TERMINAL_RELAY_GATEWAY_CA`,
`CAUCE_TERMINAL_RELAY_OUTPUT_LIMIT_BYTES`,
`CAUCE_TERMINAL_RELAY_GATEWAY_GRACE_MS`,
`CAUCE_TERMINAL_RELAY_AUTHZ_INTERVAL_MS`.

## Contract reminder

**Framing relay <-> pty-agent** (raw TLS socket, agent marks towards relay):
`[tag:1][length:4 big-endian uint32][payload]`, `length <= 65536`.

| Tag | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | AGENT_HELLO | agent -> relay | JSON |
| `0x02` | HELLO_ACK | relay -> agent | JSON `{ok}` / `{ok:false, reason}` |
| `0x10` | OPEN | relay -> agent | JSON `{session_id, ticket, mode, cols, rows}` |
| `0x11` | OPEN_OK | agent -> relay | JSON `{session_id, pid}` |
| `0x12` | OPEN_ERR | agent -> relay | JSON `{session_id, reason}` |
| `0x20` | STDIN | relay -> agent | DATA |
| `0x21` | STDOUT | agent -> relay | DATA |
| `0x22` | RESIZE | relay -> agent | JSON `{session_id, cols, rows}` |
| `0x30` | CLOSE | relay -> agent | JSON `{session_id, reason}` |
| `0x31` | CLOSED | agent -> relay | JSON `{session_id, exit_code, signal, reason}` |
| `0x40` | PING | relay -> agent | empty |
| `0x41` | PONG | agent -> relay | empty |

DATA = 36 ASCII bytes of `session_id` (UUID with dashes) + raw bytes. An
unknown tag is not ignored: the connection is closed as protocol error (4400).
The version is bumped, never guessed.

**Ticket**:
`v1.<b64url(payload_json)>.<b64url(hmac_sha256(k_alias, ascii('v1.'+b64url_payload)))>`,
b64url without padding. `k_alias = HKDF-SHA256(IKM=master32, salt='cauce-v3/pty-ticket/v1',
info='pty:'+tenant+':'+alias, L=32)`. The order of the payload keys is part of
the contract (`v, sid, op, sub, tgt{tenant, alias, container, generation, image, uid, user},
mode, iat, exp`): the bytes are signed as-is, so serializing in another order
breaks the signature.

**Browser <-> relay** (`/v3/console/terminal/ws`): the client's first frame must
be JSON text `{"type":"attach", session_id, ticket, cols, rows}`; then `input`
/ `resize` / `ping`. From the server: the PTY output is **always** in binary
frames, the control is **always** in JSON text (`ready` / `notice` / `closed`).

Close codes: `4400` protocol_error, `4401` ticket_invalid, `4403` revoked,
`4404` agent_offline, `4408` idle_timeout, `4409` session_conflict, `4413`
output_flood, `4423` ttl_expired, `1011` internal_error.

## Rules for this directory

- Native Node only, `ws` and `vitest`. No new dependencies.
- Everything runs locally with self-signed certs in a temp; no production, no
  database, no bus, no kratos.
- Never print a secret: only variable names, paths, lengths, and truncated hashes.
- Type-check with `tsc --noEmit -p tsconfig.json`, never `tsc --build` (leaves
  `.js` files in the tree).
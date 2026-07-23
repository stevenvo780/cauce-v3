# Adding a harness adapter

1. **Create a definition** under `src/harnesses/<id>.ts` implementing
   `HarnessDefinition`.
   - Use a fixed command and fixed non-secret flags.
   - Keep the user prompt exclusively in `CommandRunRequest.stdin`.
   - Do not use a shell, URL credentials, inline auth values, or secret-like
     environment variables. Auth must come from an owner-only file path.
   - Pick `sessionStrategy`: `none`, `generated`, or `observed`.
2. **Write a dialect parser** in `src/sdk/output-parser.ts`.
   - Treat native output as untrusted.
   - Normalize through `validateStructuredOutput`.
   - Reject missing fields and invalid status/retry combinations.
    - Return a native session id only as internal metadata; never relay it.
    - For a native final-text field, use the bounded plain-text fallback only
      after attempting structured JSON. Never turn malformed/object-like JSON
      into a successful plain reply.
3. **Advertise capabilities honestly** with `capabilities(id, sessions)`.
   Do not claim persistent sessions until a restart/resume test passes.
4. **Register the definition** in `src/harnesses/index.ts` and extend
   `HarnessId` in `src/sdk/types.ts`.
5. **Add a bin shim** under `src/bin/` which calls `runCli(id)`, then add it to
   `package.json#bin`.
6. **Add `manifests/<id>.json`**. Its `capabilities` object must exactly match
   the runtime definition; `test/manifests.test.ts` enforces this.
7. **Add a fake executable** under `test/fixtures/` that emits the real native
   dialect. It must cover:
   - success,
   - structured failure,
   - timeout,
   - malformed output,
   - retryable failure.
8. **Extend the matrix tests**. Also verify:
   - accepted is persisted and sent before the runner starts,
   - duplicate `delivery_id` does not run twice,
   - stale fencing epochs never execute,
   - cancel and timeout stop the process group,
   - prompts/secrets do not appear in argv or safe logs,
    - session mapping survives `DurableStore.open()` when supported,
    - session scope comes only from authenticated envelope context and is tenant-namespaced,
    - `body.session_key` never selects or joins a native session,
    - a duplicate attempt does not execute and a higher attempt executes only after retryable failure,
    - ACK receipts correlate exactly by event, delivery, attempt and claim token (including out of order),
    - recovery emits retryable `INTERRUPTED` and permits the next attempt,
   - origin is unchanged on terminal events.
9. Run:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm build
   pnpm test
   npm pack --dry-run
   ```

Do not submit a prompt to a real harness during package tests. Fake executables
and loopback servers are the compatibility boundary. The only permitted local
OpenClaw smoke is `openclaw --version` or `openclaw --help` when installed.
Portable non-TS bridges belong in `bridge/`, must be copied to `dist/bridge/`
by the build, included by `package.json#files`, and tested against fake native
modules for success, missing/ambiguous discovery, input limits and termination.

## Transport authentication checklist

- Production defaults to and requires `wss://`.
- Bearer/OIDC values come from an exactly `0600` token file and reload on reconnect.
- mTLS certificate, private-key and CA file paths are complete, exactly `0600`, and reload on reconnect.
- Development identity headers require an explicit non-production environment.
- URLs and argv contain no credentials; errors/logs contain no headers or credential material.
- A stable alias is protected by `ConsumerLease`, so reconnect closes the old consumer before opening another.

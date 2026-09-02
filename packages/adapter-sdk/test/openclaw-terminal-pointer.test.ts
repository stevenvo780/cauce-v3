import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HarnessAdapter, openClawDefinition } from "../src/harnesses/index.js";
import { DurableStore, type SessionRecord } from "../src/sdk/durable-store.js";
import type { CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import { testStateRoot } from "./test-state.js";

const root = testStateRoot("openclaw-terminal-pointer-contract");
const alias = "jarvis";
const pointerKey = `openclaw:${alias}:shared:${alias}`;

async function clean(name: string): Promise<string> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return directory;
}

async function sessions(directory: string): Promise<Record<string, SessionRecord>> {
  const document = JSON.parse(await readFile(resolve(directory, "sessions.json"), "utf8")) as {
    sessions: Record<string, SessionRecord>;
  };
  return document.sessions;
}

function record(nativeId: string, conversation = "operator:tenant:actor"): SessionRecord {
  return {
    native_id: nativeId,
    initialized: true,
    origin: { adapter: "console", channel: "console", conversation_id: conversation },
  };
}

class OkRunner implements CommandRunner {
  async run(): Promise<CommandRunResult> {
    return {
      stdout: JSON.stringify({
        reply: "ok",
        messages: [],
        status: "done",
        retryable: false,
        artifacts: [],
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

test("source mapping and non-sensitive terminal pointer commit in one sessions document", async () => {
  const directory = await clean("atomic-publication");
  const store = await DurableStore.open(directory);
  const sourceKey = `openclaw:${alias}:auth-v3:scope-one`;
  await store.setCanonicalOpenClawTerminalSession(alias, sourceKey, record("native-one"));

  const persisted = await sessions(directory);
  assert.deepEqual(persisted[sourceKey], record("native-one"));
  assert.deepEqual(persisted[pointerKey], {
    native_id: "native-one",
    initialized: true,
  });
  assert.equal("origin" in persisted[pointerKey], false, "the pointer must not duplicate conversation identity");
});

test("published pointer survives restart and a legacy pointer is sanitized under the alias lease", async () => {
  const directory = await clean("restart");
  const original = await DurableStore.open(directory);
  await original.setCanonicalOpenClawTerminalSession(
    alias,
    `openclaw:${alias}:auth-v3:scope-restart`,
    record("native-restart"),
  );

  const reopened = await DurableStore.open(directory, { deferSessions: true });
  assert.equal(await reopened.reconcileCanonicalOpenClawTerminalSession(alias), true);
  assert.deepEqual(reopened.getSession(pointerKey), {
    native_id: "native-restart",
    initialized: true,
  });

  await reopened.setSession(pointerKey, record("native-restart", "private-channel-label"));
  const migrated = await DurableStore.open(directory, { deferSessions: true });
  assert.equal(await migrated.reconcileCanonicalOpenClawTerminalSession(alias), true);
  assert.deepEqual(migrated.getSession(pointerKey), {
    native_id: "native-restart",
    initialized: true,
  });
});

test("legacy store adopts exactly one initialized human session, never guesses among many", async () => {
  const uniqueDirectory = await clean("legacy-unique");
  const unique = await DurableStore.open(uniqueDirectory);
  await unique.setSession(`openclaw:${alias}:auth-v3:only`, record("native-only"));
  await unique.setSession(`openclaw:${alias}:auth-v3:agents.agent-lane`, record("native-agent"));
  const uniqueRestart = await DurableStore.open(uniqueDirectory, { deferSessions: true });
  assert.equal(await uniqueRestart.reconcileCanonicalOpenClawTerminalSession(alias), true);
  assert.deepEqual(uniqueRestart.getSession(pointerKey), {
    native_id: "native-only",
    initialized: true,
  });

  const ambiguousDirectory = await clean("legacy-ambiguous");
  const ambiguous = await DurableStore.open(ambiguousDirectory);
  await ambiguous.setSession(`openclaw:${alias}:auth-v3:first`, record("native-first"));
  await ambiguous.setSession(`openclaw:${alias}:auth-v3:second`, record("native-second"));
  const ambiguousRestart = await DurableStore.open(ambiguousDirectory, { deferSessions: true });
  assert.equal(await ambiguousRestart.reconcileCanonicalOpenClawTerminalSession(alias), false);
  assert.equal(ambiguousRestart.getSession(pointerKey), undefined);
});

test("missing, corrupt and non-owner-only stores fail closed without manufacturing a pointer", async () => {
  const missingDirectory = await clean("missing");
  const missing = await DurableStore.open(missingDirectory, { deferSessions: true });
  assert.equal(await missing.reconcileCanonicalOpenClawTerminalSession(alias), false);
  assert.equal(missing.getSession(pointerKey), undefined);

  for (const scenario of ["corrupt", "permissions"] as const) {
    const directory = await clean(scenario);
    const store = await DurableStore.open(directory);
    await store.setSession(`openclaw:${alias}:auth-v3:source`, record("native-private"));
    if (scenario === "corrupt") {
      await writeFile(resolve(directory, "sessions.json"), "{broken\n", { mode: 0o600 });
    } else {
      await chmod(resolve(directory, "sessions.json"), 0o644);
    }
    const deferred = await DurableStore.open(directory, { deferSessions: true });
    await assert.rejects(
      deferred.reconcileCanonicalOpenClawTerminalSession(alias),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "INVALID_SESSIONS_FILE"
        && !error.message.includes("native-private"),
    );
    assert.equal(deferred.getSession(pointerKey), undefined);
  }
});

test("concurrent human-session publications retain every mapping and select the last completion", async () => {
  const directory = await clean("concurrent");
  const store = await DurableStore.open(directory);
  const writes = Array.from({ length: 32 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return store.setCanonicalOpenClawTerminalSession(
      alias,
      `openclaw:${alias}:auth-v3:scope-${suffix}`,
      record(`native-${suffix}`, `channel-${suffix}`),
    );
  });
  await Promise.all(writes);

  const persisted = await sessions(directory);
  for (let index = 0; index < writes.length; index += 1) {
    const suffix = String(index).padStart(2, "0");
    assert.equal(persisted[`openclaw:${alias}:auth-v3:scope-${suffix}`]?.native_id, `native-${suffix}`);
  }
  assert.deepEqual(persisted[pointerKey], {
    native_id: "native-31",
    initialized: true,
  });
});

test("HarnessAdapter publishes human sessions but an independent agent lane never moves the pointer", async () => {
  const directory = await clean("lane-contract");
  const store = await DurableStore.open(directory);
  const harness = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OkRunner(),
    store,
    sessionNamespace: alias,
    fallbackSessionKey: "alias-default",
  });
  const base = {
    prompt: "bounded test",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  };
  await harness.execute({ ...base, sessionKey: "human-scope", sessionLane: "human" });
  const selected = store.getSession(pointerKey);
  assert.ok(selected);

  await harness.execute({ ...base, sessionKey: "agent-scope", sessionLane: "agent" });
  assert.deepEqual(store.getSession(pointerKey), selected);
  assert.equal(store.getSession(`openclaw:${alias}:agent-scope.agent-lane`)?.initialized, true);
});

test("invalid alias and cross-alias source are rejected without echoing supplied values", async () => {
  const directory = await clean("scope-validation");
  const store = await DurableStore.open(directory);
  for (const [candidateAlias, source] of [
    ["Invalid Alias", "openclaw:jarvis:auth-v3:private-source"],
    [alias, "openclaw:janus:auth-v3:private-source"],
  ] as const) {
    await assert.rejects(
      store.setCanonicalOpenClawTerminalSession(candidateAlias, source, record("private-native")),
      (error: unknown) => error instanceof Error
        && !error.message.includes(candidateAlias)
        && !error.message.includes(source)
        && !error.message.includes("private-native"),
    );
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  SHARED_TUI_POINTER_FILE,
  SharedTuiPointerStore,
  type NativePointerBinding,
} from "../src/shared-session/native-pointer.js";
import { resolveClaudeLaunch, sharedSessionResume } from "../src/shared-session/resume.js";
import { ensureSharedSession, transcriptDirectoryIn } from "../src/shared-session/session.js";
import type { ResumeSpec } from "../src/shared-session/types.js";
import { FakeTmux } from "./shared-session-fixtures.js";
import { testStateRoot } from "./test-state.js";

const root = testStateRoot("shared-session-exact-resume");
const generation = "$1:@2:%3:4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function fresh(name: string): Promise<{
  readonly directory: string;
  readonly stateDirectory: string;
  readonly binding: NativePointerBinding;
  readonly store: SharedTuiPointerStore;
}> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const stateDirectory = join(directory, "state");
  const configDirectory = join(directory, "config");
  const workspace = join(directory, "workspace");
  await Promise.all([
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(configDirectory, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const binding: NativePointerBinding = {
    alias: "kratos",
    harness: "claude",
    configDirectory,
    workspace,
  };
  return {
    directory,
    stateDirectory,
    binding,
    store: new SharedTuiPointerStore(stateDirectory),
  };
}

async function publish(
  fixture: Awaited<ReturnType<typeof fresh>>,
  nativeId: string,
): Promise<void> {
  assert.equal(await fixture.store.publishWitness({
    binding: fixture.binding,
    nativeId,
    paneGeneration: generation,
    stillCurrent: () => Promise.resolve(true),
  }), "written");
}

async function transcript(
  binding: NativePointerBinding,
  nativeId: string,
): Promise<string> {
  const directory = transcriptDirectoryIn(binding.configDirectory, binding.workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${nativeId}.jsonl`);
  await writeFile(path, "{}\n", { mode: 0o600 });
  return path;
}

test("creates one canonical UUID without persisting an unobserved pointer", async () => {
  const fixture = await fresh("new");
  const plan = await resolveClaudeLaunch(
    fixture.binding.configDirectory,
    fixture.binding.workspace,
    { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
  );
  assert.equal(plan.state, "launch");
  assert.equal(plan.resumed, false);
  assert.equal(plan.args[0], "--session-id");
  assert.match(plan.args[1] ?? "", UUID);
  await assert.rejects(
    readFile(join(fixture.stateDirectory, SHARED_TUI_POINTER_FILE)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("resumes only the exact canonical UUID with an accredited transcript", async () => {
  const fixture = await fresh("resume");
  const nativeId = randomUUID();
  await publish(fixture, nativeId);
  await transcript(fixture.binding, nativeId);

  assert.deepEqual(await resolveClaudeLaunch(
    fixture.binding.configDirectory,
    fixture.binding.workspace,
    { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
  ), { state: "launch", args: ["--resume", nativeId], resumed: true });
});

test("fails closed for missing, unsafe or replaced exact transcript state", async (t) => {
  await t.test("missing exact transcript", async () => {
    const fixture = await fresh("missing-exact");
    await publish(fixture, randomUUID());
    assert.equal((await resolveClaudeLaunch(
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    )).state, "blocked");
  });

  await t.test("symlink and hardlink transcript", async () => {
    const symbolic = await fresh("symbolic-transcript");
    const nativeId = randomUUID();
    await publish(symbolic, nativeId);
    const directory = transcriptDirectoryIn(
      symbolic.binding.configDirectory,
      symbolic.binding.workspace,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const external = join(symbolic.directory, "external.jsonl");
    await writeFile(external, "{}\n", { mode: 0o600 });
    await symlink(external, join(directory, `${nativeId}.jsonl`));
    assert.equal((await resolveClaudeLaunch(
      symbolic.binding.configDirectory,
      symbolic.binding.workspace,
      { alias: symbolic.binding.alias, stateDirectory: symbolic.stateDirectory },
    )).state, "blocked");

    const linked = await fresh("hardlinked-transcript");
    const linkedId = randomUUID();
    await publish(linked, linkedId);
    const linkedPath = await transcript(linked.binding, linkedId);
    await link(linkedPath, join(linked.directory, "transcript-hardlink"));
    assert.equal((await resolveClaudeLaunch(
      linked.binding.configDirectory,
      linked.binding.workspace,
      { alias: linked.binding.alias, stateDirectory: linked.stateDirectory },
    )).state, "blocked");
  });

  await t.test("world-writable transcript", async () => {
    const fixture = await fresh("unsafe-transcript-mode");
    const nativeId = randomUUID();
    await publish(fixture, nativeId);
    const path = await transcript(fixture.binding, nativeId);
    await chmod(path, 0o622);
    assert.equal((await resolveClaudeLaunch(
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    )).state, "blocked");
  });

  await t.test("recreated config directory at the same path", async () => {
    const fixture = await fresh("recreated-config");
    const nativeId = randomUUID();
    await publish(fixture, nativeId);
    await transcript(fixture.binding, nativeId);
    await rm(fixture.binding.configDirectory, { recursive: true });
    await mkdir(fixture.binding.configDirectory, { mode: 0o700 });
    assert.equal((await resolveClaudeLaunch(
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    )).state, "blocked");
  });
});

test("legacy or unreadable state never selects a blank or latest conversation", async (t) => {
  await t.test("legacy history without pointer", async () => {
    const fixture = await fresh("legacy");
    await transcript(fixture.binding, randomUUID());
    assert.equal((await resolveClaudeLaunch(
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    )).state, "blocked");
  });

  await t.test("corrupt pointer", async () => {
    const fixture = await fresh("corrupt");
    await writeFile(join(fixture.stateDirectory, SHARED_TUI_POINTER_FILE), "{}\n", { mode: 0o600 });
    assert.equal((await resolveClaudeLaunch(
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    )).state, "blocked");
  });
});

test("an exact resume failure is not retried as a blank session", async () => {
  const fixture = await fresh("resume-failure");
  const nativeId = randomUUID();
  await publish(fixture, nativeId);
  await transcript(fixture.binding, nativeId);
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.fatalPaneArguments = "--resume";

  const result = await ensureSharedSession(tmux, {
    alias: fixture.binding.alias,
    harness: "claude",
    workspace: fixture.binding.workspace,
    command: "claude",
    resume: sharedSessionResume(
      "claude",
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    ),
  }, { sleep: () => Promise.resolve(), readyTimeoutMs: 30 });

  assert.equal(result.ready, false);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
  assert.match(tmux.calls.find((call) => call[0] === "new-session")?.at(-1) ?? "", /--resume/u);
});

test("an unreadable workspace preserves the exact pane without crediting it", async () => {
  const fixture = await fresh("unreadable-created-workspace");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.paneCurrentPathOverride = join(fixture.directory, "missing-workspace");

  const result = await ensureSharedSession(tmux, {
    alias: fixture.binding.alias,
    harness: "claude",
    workspace: fixture.binding.workspace,
    command: "claude",
    resume: sharedSessionResume(
      "claude",
      fixture.binding.configDirectory,
      fixture.binding.workspace,
      { alias: fixture.binding.alias, stateDirectory: fixture.stateDirectory },
    ),
  }, { sleep: () => Promise.resolve(), readyTimeoutMs: 30 });

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_identity_unverified");
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
  assert.equal(tmux.calls.filter((call) => call[0] === "kill-session").length, 0);
});

test("an existing pane is preserved without resolving or replacing its conversation", async () => {
  const fixture = await fresh("existing-pane");
  const tmux = new FakeTmux();
  tmux.paneCurrentPath = fixture.binding.workspace;
  let resolutions = 0;
  const resume: ResumeSpec = {
    resolveLaunch: async () => {
      resolutions += 1;
      throw new Error("must not resolve for an existing pane");
    },
  };

  const result = await ensureSharedSession(tmux, {
    alias: "kratos",
    harness: "claude",
    workspace: fixture.binding.workspace,
    command: "claude",
    resume,
  }, { sleep: () => Promise.resolve(), readyTimeoutMs: 30 });

  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.equal(resolutions, 0);
  assert.equal(tmux.calls.some((call) => call[0] === "new-session"), false);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);

  const mismatch = new FakeTmux();
  mismatch.paneCurrentPath = fixture.directory;
  const rejected = await ensureSharedSession(mismatch, {
    alias: "kratos",
    harness: "claude",
    workspace: fixture.binding.workspace,
    command: "claude",
    resume,
  }, { sleep: () => Promise.resolve(), readyTimeoutMs: 30 });
  assert.equal(rejected.ready, false);
  assert.equal(rejected.failure, "workspace_mismatch");
  assert.equal(resolutions, 0);
  assert.equal(mismatch.calls.some((call) => call[0] === "kill-session"), false);
});

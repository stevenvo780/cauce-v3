import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { AtomicRecoveryError } from "../src/sdk/durable-store/atomic-state.js";
import {
  SHARED_TUI_POINTER_FILE,
  SharedTuiPointerStore,
  type NativePointerBinding,
} from "../src/shared-session/native-pointer.js";
import { testStateRoot } from "./test-state.js";

const root = testStateRoot("shared-tui-native-pointer");
const generation = "$1:@2:%3:4";

type AtomicCrashWindow = "tmp" | "backup-tmp" | "backup" | "committed";

const atomicCrashChild = String.raw`
  import { open, rename, writeFile } from "node:fs/promises";
  import { dirname } from "node:path";
  const spec = JSON.parse(process.argv[1]);
  const durableWrite = async (path, body) => {
    await writeFile(path, body, { mode: 0o600 });
    const handle = await open(path, "r+");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
  };
  await durableWrite(spec.target, spec.previous);
  await durableWrite(spec.tmp, spec.next);
  if (spec.window === "backup-tmp") {
    await durableWrite(spec.backupTmp, spec.previous);
  } else if (spec.window === "backup") {
    await rename(spec.target, spec.backup);
  } else if (spec.window === "committed") {
    await durableWrite(spec.backupTmp, spec.previous);
    await rename(spec.backupTmp, spec.backup);
    await rename(spec.tmp, spec.target);
    await rename(spec.backup, spec.committed);
  }
  const directory = await open(dirname(spec.target), "r");
  await directory.sync();
  await directory.close();
  process.stdout.write("READY\\n");
  setInterval(() => undefined, 60_000);
`;

async function crashAtAtomicWindow(
  directory: string,
  window: AtomicCrashWindow,
  previous: string,
  next: string,
): Promise<string> {
  const transaction = "99999999-9999-4999-8999-999999999999";
  const target = resolve(directory, SHARED_TUI_POINTER_FILE);
  const prefix = `${target}.${transaction}.atomic-`;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    atomicCrashChild,
    JSON.stringify({
      target,
      window,
      previous,
      next,
      tmp: `${prefix}tmp`,
      backupTmp: `${prefix}backup-tmp`,
      backup: `${prefix}backup`,
      committed: `${prefix}committed`,
    }),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => { resolveExit({ code, signal }); });
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`atomic crash child did not become ready: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `atomic crash child exited before SIGKILL (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      ));
    });
  });
  assert.equal(child.kill("SIGKILL"), true);
  const outcome = await exited;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  return window === "committed" ? next : previous;
}

async function fresh(name: string): Promise<{
  readonly directory: string;
  readonly configDirectory: string;
  readonly workspace: string;
  readonly binding: NativePointerBinding;
  readonly store: SharedTuiPointerStore;
}> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const stateDirectory = resolve(directory, "state");
  const configDirectory = resolve(directory, "config");
  const workspace = resolve(directory, "workspace");
  await Promise.all([
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(configDirectory, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const binding: NativePointerBinding = {
    alias: "zeus",
    harness: "claude",
    configDirectory,
    workspace,
  };
  return {
    directory,
    configDirectory,
    workspace,
    binding,
    store: new SharedTuiPointerStore(stateDirectory),
  };
}

function witness(
  binding: NativePointerBinding,
  nativeId: string,
  expectedNativeId?: string,
): {
  readonly binding: NativePointerBinding;
  readonly nativeId: string;
  readonly expectedNativeId?: string;
  readonly paneGeneration: string;
  stillCurrent(): Promise<boolean>;
} {
  return {
    binding,
    nativeId,
    ...(expectedNativeId === undefined ? {} : { expectedNativeId }),
    paneGeneration: generation,
    stillCurrent: () => Promise.resolve(true),
  };
}

test("publishes only a private canonical Claude pointer and reads through path aliases", async () => {
  const fixture = await fresh("canonical");
  const configAlias = resolve(fixture.directory, "config-link");
  const workspaceAlias = resolve(fixture.directory, "workspace-link");
  await symlink(fixture.configDirectory, configAlias, "dir");
  await symlink(fixture.workspace, workspaceAlias, "dir");
  const aliased: NativePointerBinding = {
    ...fixture.binding,
    configDirectory: configAlias,
    workspace: workspaceAlias,
  };

  assert.deepEqual(await fixture.store.read(aliased), { state: "absent" });
  assert.equal(await fixture.store.publishWitness(witness(aliased, "claude-native-one")), "written");
  assert.equal(await fixture.store.publishWitness(witness(fixture.binding, "claude-native-one")), "unchanged");
  assert.deepEqual(await fixture.store.read(aliased), {
    state: "valid",
    binding: fixture.binding,
    nativeId: "claude-native-one",
  });

  const path = resolve(fixture.directory, "state", SHARED_TUI_POINTER_FILE);
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  const text = await readFile(path, "utf8");
  const persisted = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted), ["schemaVersion", "binding", "native_id"]);
  assert.deepEqual(persisted, {
    schemaVersion: 1,
    binding: fixture.binding,
    native_id: "claude-native-one",
  });
  assert.doesNotMatch(text, /prompt|nonce|transcript|origin|paneGeneration/iu);
});

test("accepts aliases with the globally valid underscore form", async () => {
  const fixture = await fresh("alias-underscore");
  const binding = { ...fixture.binding, alias: "shared_worker" };
  assert.equal(await fixture.store.publishWitness(witness(binding, "claude-native-one")), "written");
  assert.equal((await fixture.store.read(binding)).state, "valid");
});

test("requires an exact expected native id to move an established pointer", async () => {
  const { store, binding, workspace, directory } = await fresh("cas");
  assert.equal(await store.publishWitness(witness(binding, "claude-native-one")), "written");
  assert.equal(await store.publishWitness(witness(binding, "claude-native-two")), "conflict");
  assert.equal(
    await store.publishWitness(witness(binding, "claude-native-two", "claude-native-stale")),
    "conflict",
  );

  const otherWorkspace = resolve(directory, "other-workspace");
  await mkdir(otherWorkspace, { mode: 0o700 });
  assert.equal(await store.publishWitness(witness({
    ...binding,
    workspace: otherWorkspace,
  }, "claude-native-one")), "conflict");
  assert.deepEqual(await store.read({ ...binding, workspace: otherWorkspace }), { state: "invalid" });

  assert.equal(
    await store.publishWitness(witness(binding, "claude-native-two", "claude-native-one")),
    "written",
  );
  assert.equal(
    await store.publishWitness(witness(binding, "claude-native-three", "claude-native-one")),
    "conflict",
  );
  assert.equal((await store.read({ ...binding, workspace })).state, "valid");
  assert.equal((await store.read(binding) as { nativeId?: string }).nativeId, "claude-native-two");
});

test("rechecks the pane witness inside the serialized CAS before every write", async () => {
  const fixture = await fresh("pane-fence");
  let checks = 0;
  const stale = {
    ...witness(fixture.binding, "claude-native-one"),
    stillCurrent: async (): Promise<boolean> => {
      checks += 1;
      return false;
    },
  };
  assert.equal(await fixture.store.publishWitness(stale), "conflict");
  assert.equal(checks, 1);
  assert.deepEqual(await fixture.store.read(fixture.binding), { state: "absent" });

  assert.equal(await fixture.store.publishWitness(witness(
    fixture.binding,
    "claude-native-one",
  )), "written");
  const errored = {
    ...witness(fixture.binding, "claude-native-two", "claude-native-one"),
    stillCurrent: async (): Promise<boolean> => {
      checks += 1;
      throw new Error("pane changed");
    },
  };
  assert.equal(await fixture.store.publishWitness(errored), "conflict");
  assert.equal(checks, 2);
  assert.equal((await fixture.store.read(fixture.binding) as { nativeId?: string }).nativeId,
    "claude-native-one");

  const staleCas = {
    ...witness(fixture.binding, "claude-native-three", "wrong-native-id"),
    stillCurrent: async (): Promise<boolean> => {
      checks += 1;
      return true;
    },
  };
  assert.equal(await fixture.store.publishWitness(staleCas), "conflict");
  assert.equal(checks, 2, "a failed state CAS must not consult or credit the pane fence");
});

test("serializes same-id, conflicting and competing CAS publications across store instances", async () => {
  const same = await fresh("concurrent-same");
  const sameStores = Array.from(
    { length: 16 },
    () => new SharedTuiPointerStore(resolve(same.directory, "state")),
  );
  const sameResults = await Promise.all(
    sameStores.map((store) => store.publishWitness(witness(same.binding, "claude-native-one"))),
  );
  assert.equal(sameResults.filter((result) => result === "written").length, 1);
  assert.equal(sameResults.filter((result) => result === "unchanged").length, 15);

  const different = await fresh("concurrent-different");
  const differentResults = await Promise.all(Array.from({ length: 16 }, (_, index) => (
    new SharedTuiPointerStore(resolve(different.directory, "state")).publishWitness(
      witness(different.binding, `claude-native-${String(index)}`),
    )
  )));
  assert.equal(differentResults.filter((result) => result === "written").length, 1);
  assert.equal(differentResults.filter((result) => result === "conflict").length, 15);

  const cas = await fresh("concurrent-cas");
  await cas.store.publishWitness(witness(cas.binding, "claude-native-before"));
  const casResults = await Promise.all(["left", "right"].map((suffix) => (
    new SharedTuiPointerStore(resolve(cas.directory, "state")).publishWitness(
      witness(cas.binding, `claude-native-${suffix}`, "claude-native-before"),
    )
  )));
  assert.equal(casResults.filter((result) => result === "written").length, 1);
  assert.equal(casResults.filter((result) => result === "conflict").length, 1);
});

test("rejects malformed, non-private, symlinked and hardlinked pointer files", async () => {
  const malformed = await fresh("malformed");
  const malformedPath = resolve(malformed.directory, "state", SHARED_TUI_POINTER_FILE);
  await writeFile(malformedPath, "{\"schemaVersion\":1,\"schemaVersion\":1}\n", { mode: 0o600 });
  assert.deepEqual(await malformed.store.read(malformed.binding), { state: "invalid" });
  assert.equal(
    await malformed.store.publishWitness(witness(malformed.binding, "claude-native-one")),
    "conflict",
  );

  const permissions = await fresh("permissions");
  const permissionsPath = resolve(permissions.directory, "state", SHARED_TUI_POINTER_FILE);
  await writeFile(permissionsPath, "{}\n", { mode: 0o600 });
  await chmod(permissionsPath, 0o644);
  assert.deepEqual(await permissions.store.read(permissions.binding), { state: "invalid" });

  const linked = await fresh("hardlink");
  await linked.store.publishWitness(witness(linked.binding, "claude-native-one"));
  const linkedPath = resolve(linked.directory, "state", SHARED_TUI_POINTER_FILE);
  await link(linkedPath, resolve(linked.directory, "pointer-hardlink"));
  assert.deepEqual(await linked.store.read(linked.binding), { state: "invalid" });
  assert.equal(
    await linked.store.publishWitness(witness(linked.binding, "claude-native-two", "claude-native-one")),
    "conflict",
  );

  const symbolic = await fresh("symlink");
  const external = resolve(symbolic.directory, "external.json");
  await writeFile(external, "untouched\n", { mode: 0o600 });
  await symlink(external, resolve(symbolic.directory, "state", SHARED_TUI_POINTER_FILE));
  assert.deepEqual(await symbolic.store.read(symbolic.binding), { state: "invalid" });
  assert.equal(
    await symbolic.store.publishWitness(witness(symbolic.binding, "claude-native-one")),
    "conflict",
  );
  assert.equal(await readFile(external, "utf8"), "untouched\n");

  const oversized = await fresh("oversized");
  const oversizedPath = resolve(oversized.directory, "state", SHARED_TUI_POINTER_FILE);
  await writeFile(oversizedPath, Buffer.alloc(16 * 1024 + 1, 0x20), { mode: 0o600 });
  assert.deepEqual(await oversized.store.read(oversized.binding), { state: "invalid" });

  const unsafeDirectory = await fresh("unsafe-directory");
  await chmod(resolve(unsafeDirectory.directory, "state"), 0o777);
  assert.deepEqual(await unsafeDirectory.store.read(unsafeDirectory.binding), { state: "invalid" });
  assert.equal(
    await unsafeDirectory.store.publishWitness(witness(
      unsafeDirectory.binding,
      "claude-native-one",
    )),
    "conflict",
  );
});

test("preserves the prior pointer when durable commit fsync fails", async () => {
  const fixture = await fresh("fsync-failure");
  await fixture.store.publishWitness(witness(fixture.binding, "claude-native-before"));
  const path = resolve(fixture.directory, "state", SHARED_TUI_POINTER_FILE);
  const before = await readFile(path, "utf8");
  let calls = 0;
  const failing = new SharedTuiPointerStore(resolve(fixture.directory, "state"), {
    directoryFsync: async (handle) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      await handle.sync();
    },
  });

  await assert.rejects(
    failing.publishWitness(witness(
      fixture.binding,
      "claude-native-after",
      "claude-native-before",
    )),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(calls, 3);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await fixture.store.read(fixture.binding), {
    state: "valid",
    binding: fixture.binding,
    nativeId: "claude-native-before",
  });
});

test("keeps reads non-mutating and recovers every SIGKILL atomic window explicitly", async (t) => {
  const windows: readonly AtomicCrashWindow[] = ["tmp", "backup-tmp", "backup", "committed"];
  for (const window of windows) {
    await t.test(window, async () => {
      const fixture = await fresh(`crash-${window}`);
      const stateDirectory = resolve(fixture.directory, "state");
      const previous = `${JSON.stringify({
        schemaVersion: 1,
        binding: fixture.binding,
        native_id: "claude-native-before",
      })}\n`;
      const next = `${JSON.stringify({
        schemaVersion: 1,
        binding: fixture.binding,
        native_id: "claude-native-after",
      })}\n`;
      const expected = await crashAtAtomicWindow(stateDirectory, window, previous, next);

      assert.deepEqual(await fixture.store.read(fixture.binding), { state: "invalid" });
      const beforeRecovery = await readdir(stateDirectory);
      assert.equal(beforeRecovery.some((entry) => entry.includes(".atomic-")), true);

      await fixture.store.recover();

      assert.equal(await readFile(resolve(stateDirectory, SHARED_TUI_POINTER_FILE), "utf8"), expected);
      assert.equal((await fixture.store.read(fixture.binding) as { nativeId?: string }).nativeId,
        window === "committed" ? "claude-native-after" : "claude-native-before");
      assert.equal(
        (await readdir(stateDirectory)).some((entry) => entry.includes(".atomic-")),
        false,
      );
    });
  }
});

test("fails closed without consuming ambiguous atomic artifacts", async () => {
  const fixture = await fresh("crash-ambiguous");
  await fixture.store.publishWitness(witness(fixture.binding, "claude-native-before"));
  const stateDirectory = resolve(fixture.directory, "state");
  const target = resolve(stateDirectory, SHARED_TUI_POINTER_FILE);
  const transaction = "88888888-8888-4888-8888-888888888888";
  const backup = `${target}.${transaction}.atomic-backup`;
  const committed = `${target}.${transaction}.atomic-committed`;
  await writeFile(backup, await readFile(target), { mode: 0o600 });
  await writeFile(committed, await readFile(target), { mode: 0o600 });
  const directory = await open(stateDirectory, "r");
  await directory.sync();
  await directory.close();

  assert.deepEqual(await fixture.store.read(fixture.binding), { state: "invalid" });
  await assert.rejects(
    fixture.store.recover(),
    (error: unknown) => error instanceof AtomicRecoveryError,
  );
  assert.deepEqual(await fixture.store.read(fixture.binding), { state: "invalid" });
  assert.equal((await readdir(stateDirectory)).filter((entry) => entry.includes(".atomic-")).length, 2);
});

test("rejects unavailable bindings and non-pane witnesses without creating state", async () => {
  const fixture = await fresh("input-validation");
  const missingBinding = { ...fixture.binding, workspace: resolve(fixture.directory, "missing") };
  await assert.rejects(
    fixture.store.read(missingBinding),
    /binding directory is unavailable/u,
  );
  await assert.rejects(
    fixture.store.publishWitness({
      ...witness(fixture.binding, "claude-native-private"),
      paneGeneration: "not-a-pane-generation",
    }),
    (error: unknown) => error instanceof Error
      && !error.message.includes("claude-native-private")
      && !error.message.includes("not-a-pane-generation"),
  );
  await assert.rejects(
    readFile(resolve(fixture.directory, "state", SHARED_TUI_POINTER_FILE)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  FICHEROS_OPENCLAW,
  MARCA_FIN,
  MARCA_INICIO,
  MARCA_PERFIL_FIN,
  MARCA_PERFIL_INICIO,
  TOPES_OPENCLAW,
  conBloqueDePerfil,
  conBloqueGestionado,
  marcaDeRevisionDelPerfil,
  measureStrictestUnits,
} from "@cauce/protocol";
import {
  nativeProfileContextEnabled, profileReloadRequest,
} from "../src/context/native-profile-context.js";
import { siembraHabilitada } from "../src/sdk/client.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { profileAdoptionFor } from "../src/sdk/engine.js";
import { HarnessAdapter } from "../src/harnesses/index.js";
import {
  PRIMARY_DUTY_HEADER,
  type HarnessRequestContext,
  type RuntimeProfileMeasurement,
} from "../src/harnesses/shared.js";
import { textoNativoDelSobre } from "../src/harnesses/shared/prompt.js";
import type {
  CommandRunRequest, CommandRunResult, CommandRunner,
} from "../src/sdk/types.js";
import { delivery } from "./engine-fixtures.js";
import {
  captureStderr, contract, context, definition, hash, nativeEnvironment, profileFile,
  restoreEnvironment, spyRunner,
} from "./native-profile-fixtures.js";

test("native profile flag accepts only absent, 0, or 1", () => {
  assert.equal(nativeProfileContextEnabled(undefined), false);
  assert.equal(nativeProfileContextEnabled("0"), false);
  assert.equal(nativeProfileContextEnabled("1"), true);
  for (const invalid of ["", "true", "01", " 1", "2"]) {
    assert.throws(() => nativeProfileContextEnabled(invalid), /exactly 0 or 1/u);
  }
  assert.equal(siembraHabilitada({ CAUCE_SEMBRAR_PERFIL: "1" }), true);
  assert.equal(siembraHabilitada({
    CAUCE_SEMBRAR_PERFIL: "1",
    CAUCE_NATIVE_PROFILE_CONTEXT: "1",
  }), false);
});

test("native profile flag rejects an unsupported harness before disk access", async () => {
  const state = mkdtempSync(join(tmpdir(), "cauce-native-options-"));
  try {
    const store = await DurableStore.open(state);
    const { runner } = spyRunner();
    assert.throws(() => new HarnessAdapter({
      definition: definition("fake"), runner, store, environment: nativeEnvironment(),
    }), /only supported by claude and openclaw/u);
    assert.doesNotThrow(() => new HarnessAdapter({
      definition: definition("fake"), runner, store, environment: nativeEnvironment("0"),
    }));
    const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
    delete process.env.CAUCE_CONTAINER_GENERATION;
    try {
      assert.throws(() => new HarnessAdapter({
        definition: definition("claude"), runner, store, environment: nativeEnvironment(),
      }), /requires CAUCE_CONTAINER_GENERATION/u);
    } finally {
      restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("native profile flag on a shared-session alias warns loudly instead of aborting the process", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "cauce-native-shared-session-"));
  t.after(() => { rmSync(state, { recursive: true, force: true }); });
  const store = await DurableStore.open(state);
  const { runner, requests } = spyRunner();
  const capture = captureStderr();
  let adapter: HarnessAdapter | undefined;
  try {
    assert.doesNotThrow(() => {
      adapter = new HarnessAdapter({
        definition: definition("claude"),
        runner,
        store,
        environment: nativeEnvironment(),
        sharedSession: { alias: "zeus", harness: "claude", stateDirectory: state },
      });
    });
  } finally {
    capture.restore();
  }
  const warning = capture.lines
    .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
    .find((entry) => entry?.event === "native_profile_context_shared_session_disabled");
  assert.ok(warning, "expected a loud stderr warning when the flag is forced off");
  assert.equal(warning.alias, "zeus");
  assert.equal(warning.harness, "claude");
  assert.ok(adapter, "adapter was not constructed");
  await adapter.execute({
    prompt: "Shared session stays on the legacy path.",
    context: context("zeus"),
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]?.stdin ?? "", /native_profile_(?:context|measurement|contract)/u);
});

test("absent and zero native flags preserve the legacy prompt byte for byte", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-default-off-"));
  const previousFlag = process.env.CAUCE_NATIVE_PROFILE_CONTEXT;
  t.after(() => {
    restoreEnvironment("CAUCE_NATIVE_PROFILE_CONTEXT", previousFlag);
    rmSync(root, { recursive: true, force: true });
  });
  const profile: RuntimeProfileMeasurement = {
    source: "runtime-files",
    sha256: "a".repeat(64),
    documents: [{ path: "/does/not/exist/CLAUDE.md", sha256: "b".repeat(64) }],
    text: "LEGACY PROFILE",
  };
  const deliveryContext: HarnessRequestContext = {
    ...context("zeus"),
    runtime_profile: profile,
  };
  const contractedContext: HarnessRequestContext = {
    ...deliveryContext,
    native_profile_contract: {
      revision: 17,
      generation: "runtime-17",
      documents: [{
        name: "CLAUDE.md",
        path: "/does/not/exist/CLAUDE.md",
        sha: "b".repeat(64),
      }],
    },
  };

  const run = async (
    flag: string | undefined,
    requestContext: HarnessRequestContext,
    state: string,
  ): Promise<string> => {
    restoreEnvironment("CAUCE_NATIVE_PROFILE_CONTEXT", flag);
    const { runner, requests } = spyRunner();
    const adapter = new HarnessAdapter({
      definition: definition("fake"),
      runner,
      store: await DurableStore.open(join(root, state)),
    });
    await adapter.execute({
      prompt: "Keep legacy bytes.",
      context: requestContext,
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(requests.length, 1);
    return requests[0]?.stdin ?? "";
  };

  const legacy = await run(undefined, deliveryContext, "legacy");
  assert.equal(await run(undefined, contractedContext, "absent"), legacy);
  assert.equal(await run("0", contractedContext, "zero"), legacy);
  assert.match(legacy, /BEGIN TRUSTED RUNTIME PROFILE[\s\S]*LEGACY PROFILE/u);
});

test("claude projects the fixed contract and sends only pointer, metadata, and request", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-claude-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const state = join(root, "state");
  mkdirSync(config, { recursive: true });
  const path = join(config, "CLAUDE.md");
  const profile = profileFile("zeus", 7, "## Rol\n\nPROFILE-NATIVE-CLAUDE");
  writeFileSync(path, `# Human manual\n\n${profile}`, "utf8");
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-7";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    restoreEnvironment("HOME", previousHome);
    restoreEnvironment("CLAUDE_CONFIG_DIR", previousConfig);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  const { runner, requests } = spyRunner();
  const adapter = new HarnessAdapter({
    definition: definition("claude"),
    runner,
    store: await DurableStore.open(state),
    environment: nativeEnvironment(),
  });
  let measured: RuntimeProfileMeasurement | undefined;
  const base = context("zeus");
  const initialContract = contract(7, [path]);
  await adapter.execute({
    prompt: "Inspect the gateway.",
    context: { ...base, native_profile_contract: initialContract },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
    onRuntimeProfileConsumed: (value) => { measured = value; },
  });

  assert.equal(requests.length, 1);
  const stdin = requests[0]?.stdin ?? "";
  assert.doesNotMatch(stdin, new RegExp(PRIMARY_DUTY_HEADER, "u"));
  assert.doesNotMatch(stdin, /BEGIN TRUSTED RUNTIME PROFILE|PROFILE-NATIVE-CLAUDE|ROLE-SENTINEL/u);
  assert.doesNotMatch(stdin, /native_profile_(?:context|measurement|contract)/u);
  assert.match(stdin, /contexto Cauce v/u);
  assert.match(stdin, /--- BEGIN REQUEST ---\nInspect the gateway\./u);
  const finalFile = readFileSync(path, "utf8");
  assert.match(finalFile, /# Human manual/u);
  assert.match(finalFile, /PROFILE-NATIVE-CLAUDE/u);
  assert.match(finalFile, new RegExp(PRIMARY_DUTY_HEADER, "u"));
  assert.equal(measured?.documents.length, 1);
  assert.equal(measured.documents[0]?.sha256, hash(finalFile));
  assert.equal(profileAdoptionFor({
    ...delivery("nativefirst"),
    recipient_alias: "zeus",
    profile_runtime_contract: initialContract,
  }, measured), undefined);

  const refreshedContract = contract(7, [path]);
  let refreshedMeasurement: RuntimeProfileMeasurement | undefined;
  await adapter.execute({
    prompt: "Inspect the gateway again.",
    context: { ...base, native_profile_contract: refreshedContract },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
    onRuntimeProfileConsumed: (value) => { refreshedMeasurement = value; },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(profileAdoptionFor({
    ...delivery("nativesecond"),
    recipient_alias: "zeus",
    profile_runtime_contract: refreshedContract,
  }, refreshedMeasurement), {
    evidence: "adapter_delivery",
    revision: 7,
    generation: "runtime-7",
    documents: [{ name: "CLAUDE.md", path, sha: hash(finalFile) }],
  });
});

test("native fixed text is stable across rooms and authored role changes", () => {
  const first = context("zeus");
  const second = {
    ...first,
    room_id: "grp.other",
    self_role: "A newer authored role",
    message_type: "agent.response",
  };
  assert.equal(textoNativoDelSobre(first), textoNativoDelSobre(second));
});

test("native file drift during execution withholds adoption evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-postrun-drift-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const path = join(config, "CLAUDE.md");
  mkdirSync(config, { recursive: true });
  const base = context("zeus");
  writeFileSync(
    path,
    conBloqueGestionado(
      profileFile("zeus", 21, "PROFILE-STABLE"),
      textoNativoDelSobre(base),
    ),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-21";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    restoreEnvironment("HOME", previousHome);
    restoreEnvironment("CLAUDE_CONFIG_DIR", previousConfig);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  let runs = 0;
  let consumed = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runs += 1;
      writeFileSync(path, `${readFileSync(path, "utf8")}\n# Concurrent edit\n`, "utf8");
      return {
        stdout: "ignored",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
    },
  };
  const adapter = new HarnessAdapter({
    definition: definition("claude"),
    runner,
    store: await DurableStore.open(join(root, "state")),
    environment: nativeEnvironment(),
  });
  await adapter.execute({
    prompt: "Run once.",
    context: { ...base, native_profile_contract: contract(21, [path]) },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
    onRuntimeProfileConsumed: () => { consumed += 1; },
  });

  assert.equal(runs, 1);
  assert.equal(consumed, 0);
});

test("openclaw proves seven files without exposing memory, heartbeat, or profile text", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-openclaw-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  const paths = FICHEROS_OPENCLAW.map((name) => join(workspace, name));
  for (const name of FICHEROS_OPENCLAW) {
    const path = join(workspace, name);
    if (name === "MEMORY.md") writeFileSync(path, "PRIVATE-MEMORY-DO-NOT-INJECT", "utf8");
    else if (name === "HEARTBEAT.md") writeFileSync(path, "PRIVATE-HEARTBEAT-DO-NOT-INJECT", "utf8");
    else {
      writeFileSync(
        path,
        profileFile("argos", name === "AGENTS.md" ? 9 : undefined, `PROFILE-${name}`),
        "utf8",
      );
    }
  }
  const previousWorkspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.CAUCE_OPENCLAW_WORKSPACE = workspace;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-9";
  t.after(() => {
    restoreEnvironment("CAUCE_OPENCLAW_WORKSPACE", previousWorkspace);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  const { runner, requests } = spyRunner();
  const adapter = new HarnessAdapter({
    definition: definition("openclaw"),
    runner,
    store: await DurableStore.open(state),
    environment: nativeEnvironment(),
  });
  let measured: RuntimeProfileMeasurement | undefined;
  await adapter.execute({
    prompt: "Review OpenClaw.",
    context: { ...context("argos"), native_profile_contract: contract(9, paths) },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
    onRuntimeProfileConsumed: (value) => { measured = value; },
  });

  assert.ok(measured, "the runtime profile was never measured");
  const measuredDocuments = measured.documents;
  const measuredText = measured.text;
  assert.deepEqual(measuredDocuments.map((document) => basename(document.path)), FICHEROS_OPENCLAW);
  for (const document of measuredDocuments) {
    assert.equal(document.sha256, hash(readFileSync(document.path, "utf8")));
  }
  assert.doesNotMatch(measuredText, /PRIVATE-(?:MEMORY|HEARTBEAT)/u);
  const stdin = requests[0]?.stdin ?? "";
  assert.doesNotMatch(stdin, /PRIVATE-|PROFILE-(?:SOUL|IDENTITY|USER|AGENTS|TOOLS)/u);
  assert.doesNotMatch(stdin, /BEGIN TRUSTED RUNTIME PROFILE/u);
  assert.doesNotMatch(stdin, new RegExp(PRIMARY_DUTY_HEADER, "u"));
  assert.match(stdin, /--- BEGIN REQUEST ---\nReview OpenClaw\./u);
  assert.match(readFileSync(join(workspace, "AGENTS.md"), "utf8"), new RegExp(PRIMARY_DUTY_HEADER, "u"));
});

test("openclaw rejects overlapping managed blocks before modifying AGENTS.md", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-openclaw-overlap-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const paths = FICHEROS_OPENCLAW.map((name) => join(workspace, name));
  const overlapping = `${marcaDeRevisionDelPerfil(91)}\n${MARCA_PERFIL_INICIO}\n`
    + `<!-- alias: Steven/argos -->\nPROFILE-AGENTS\n${MARCA_INICIO}\n`
    + `fixed-inside-profile\n${MARCA_PERFIL_FIN}\n${MARCA_FIN}\n`;
  for (const name of FICHEROS_OPENCLAW) {
    const path = join(workspace, name);
    if (name === "MEMORY.md" || name === "HEARTBEAT.md") {
      writeFileSync(path, "agent-owned", "utf8");
    } else {
      writeFileSync(
        path,
        name === "AGENTS.md"
          ? overlapping
          : profileFile("argos", undefined, `PROFILE-${name}`),
        "utf8",
      );
    }
  }
  const agentsPath = join(workspace, "AGENTS.md");
  const previousWorkspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.CAUCE_OPENCLAW_WORKSPACE = workspace;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-91";
  t.after(() => {
    restoreEnvironment("CAUCE_OPENCLAW_WORKSPACE", previousWorkspace);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  const { runner, requests } = spyRunner();
  const adapter = new HarnessAdapter({
    definition: definition("openclaw"),
    runner,
    store: await DurableStore.open(join(root, "state")),
    environment: nativeEnvironment(),
  });
  await assert.rejects(adapter.execute({
    prompt: "must not run",
    context: { ...context("argos"), native_profile_contract: contract(91, paths) },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
  }), /overlapping (?:fixed-context and profile|managed) blocks/u);
  assert.equal(requests.length, 0);
  assert.equal(readFileSync(agentsPath, "utf8"), overlapping);
});

test("openclaw rejects a fixed block that would exceed the native document limit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-openclaw-limit-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const paths = FICHEROS_OPENCLAW.map((name) => join(workspace, name));
  const managed = profileFile("argos", 10, "PROFILE-LIMIT");
  const unversioned = profileFile("argos", undefined, "PROFILE-LIMIT");
  const padding = `${"x".repeat(
    TOPES_OPENCLAW.porFichero - measureStrictestUnits(managed) - 1,
  )}\n`;
  for (const name of FICHEROS_OPENCLAW) {
    const path = join(workspace, name);
    if (name === "MEMORY.md" || name === "HEARTBEAT.md") writeFileSync(path, "agent-owned", "utf8");
    else writeFileSync(path, name === "AGENTS.md" ? `${padding}${managed}` : unversioned, "utf8");
  }
  assert.equal(
    measureStrictestUnits(readFileSync(join(workspace, "AGENTS.md"), "utf8")),
    TOPES_OPENCLAW.porFichero,
  );
  const previousWorkspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.CAUCE_OPENCLAW_WORKSPACE = workspace;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-10";
  t.after(() => {
    restoreEnvironment("CAUCE_OPENCLAW_WORKSPACE", previousWorkspace);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  const before = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
  const { runner, requests } = spyRunner();
  const adapter = new HarnessAdapter({
    definition: definition("openclaw"),
    runner,
    store: await DurableStore.open(join(root, "state")),
    environment: nativeEnvironment(),
  });
  await assert.rejects(adapter.execute({
    prompt: "must not run",
    context: { ...context("argos"), native_profile_contract: contract(10, paths) },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
  }), /per-file limit/u);
  assert.equal(requests.length, 0);
  for (const path of paths) assert.equal(readFileSync(path, "utf8"), before.get(path));
});

test("a contract sealed with the presence generation of THIS incarnation is accepted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-presence-gen-"));
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  const previousPresence = process.env.CAUCE_CONTAINER_PRESENCE_GENERATION;
  process.env.CAUCE_CONTAINER_GENERATION = "b".repeat(64);
  process.env.CAUCE_CONTAINER_PRESENCE_GENERATION = "c".repeat(32);
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    restoreEnvironment("HOME", previousHome);
    restoreEnvironment("CLAUDE_CONFIG_DIR", previousConfig);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    restoreEnvironment("CAUCE_CONTAINER_PRESENCE_GENERATION", previousPresence);
    rmSync(root, { recursive: true, force: true });
  });

  const attempt = async (
    generation: string,
    name: string,
  ): Promise<CommandRunRequest[]> => {
    const home = join(root, name);
    const config = join(home, ".claude");
    mkdirSync(config, { recursive: true });
    const path = join(config, "CLAUDE.md");
    writeFileSync(path, profileFile("zeus", 31, "PROFILE-PRESENCE-GENERATION"), "utf8");
    process.env.HOME = home;
    const sealed = { ...contract(31, [path]), generation };
    const { runner, requests } = spyRunner();
    const adapter = new HarnessAdapter({
      definition: definition("claude"),
      runner,
      store: await DurableStore.open(join(root, `state-${name}`)),
      environment: nativeEnvironment(),
    });
    await adapter.execute({
      prompt: "Run under the sealed generation.",
      context: { ...context("zeus"), native_profile_contract: sealed },
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(2_000),
    });
    return requests;
  };

  assert.equal((await attempt("c".repeat(32), "presence")).length, 1);
  assert.equal((await attempt("b".repeat(64), "supervisor")).length, 1);

  const home = join(root, "foreign");
  const config = join(home, ".claude");
  mkdirSync(config, { recursive: true });
  const path = join(config, "CLAUDE.md");
  writeFileSync(path, profileFile("zeus", 31, "PROFILE-PRESENCE-GENERATION"), "utf8");
  process.env.HOME = home;
  const bytesBefore = readFileSync(path, "utf8");
  const { runner, requests } = spyRunner();
  const adapter = new HarnessAdapter({
    definition: definition("claude"),
    runner,
    store: await DurableStore.open(join(root, "state-foreign")),
    environment: nativeEnvironment(),
  });
  await assert.rejects(adapter.execute({
    prompt: "must not run",
    context: {
      ...context("zeus"),
      native_profile_contract: { ...contract(31, [path]), generation: "d".repeat(32) },
    },
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_000),
  }), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "NATIVE_PROFILE_CONTEXT_GENERATION_MISMATCH");
    assert.equal(profileReloadRequest(nativeEnvironment(), "zeus"), undefined);
    assert.equal((error as { retryable?: unknown }).retryable, false);
    return true;
  });
  assert.equal(requests.length, 0);
  assert.equal(readFileSync(path, "utf8"), bytesBefore);
});

test("stale, absent, foreign, and malformed projections fail before the runner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-fail-closed-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  mkdirSync(config, { recursive: true });
  const path = join(config, "CLAUDE.md");
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-11";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    restoreEnvironment("HOME", previousHome);
    restoreEnvironment("CLAUDE_CONFIG_DIR", previousConfig);
    restoreEnvironment("CAUCE_CONTAINER_GENERATION", previousGeneration);
    rmSync(root, { recursive: true, force: true });
  });

  const cases: {
    name: string;
    file: string;
    mutateContract?: boolean;
    mutateGeneration?: boolean;
    omitContract?: boolean;
    omitFile?: boolean;
    expectedCode?: string;
    expectedRetryable?: boolean;
  }[] = [
    {
      name: "stale",
      file: profileFile("zeus", 11, "CURRENT"),
      mutateContract: true,
    },
    {
      name: "absent contract",
      file: profileFile("zeus", 11, "CURRENT"),
      omitContract: true,
      expectedCode: "NATIVE_PROFILE_CONTEXT_CONTRACT_MISSING",
      expectedRetryable: false,
    },
    {
      name: "profile file missing",
      file: profileFile("zeus", 11, "CURRENT"),
      omitFile: true,
      expectedCode: "NATIVE_PROFILE_CONTEXT_FILE_MISSING",
      expectedRetryable: false,
    },
    { name: "foreign", file: profileFile("kant", 11, "FOREIGN") },
    {
      name: "malformed",
      file: `${marcaDeRevisionDelPerfil(11)}\n${MARCA_PERFIL_INICIO}\n`
        + `<!-- alias: Steven/zeus -->\nBROKEN`,
    },
    {
      name: "missing revision marker",
      file: conBloqueDePerfil("", "<!-- alias: Steven/zeus -->\nCURRENT"),
    },
    {
      name: "malformed revision marker",
      file: `<!-- CAUCE:REVISION-PERFIL v1 revision=eleven -->\n`
        + conBloqueDePerfil("", "<!-- alias: Steven/zeus -->\nCURRENT"),
    },
    { name: "wrong revision marker", file: profileFile("zeus", 12, "CURRENT") },
    { name: "no owned managed block", file: "# Human-only instructions\n" },
    {
      name: "another runtime generation",
      file: profileFile("zeus", 11, "CURRENT"),
      mutateGeneration: true,
      expectedCode: "NATIVE_PROFILE_CONTEXT_GENERATION_MISMATCH",
      expectedRetryable: false,
    },
    {
      name: "repeated fixed",
      file: profileFile("zeus", 11, "CURRENT")
        + `\n${MARCA_INICIO}\nold-a\n${MARCA_FIN}\n${MARCA_INICIO}\nold-b\n${MARCA_FIN}\n`,
    },
    {
      name: "inverted fixed",
      file: profileFile("zeus", 11, "CURRENT")
        + `\n${MARCA_FIN}\nold\n${MARCA_INICIO}\n`,
    },
    {
      name: "overlapping managed blocks",
      file: `${marcaDeRevisionDelPerfil(11)}\n${MARCA_PERFIL_INICIO}\n`
        + `<!-- alias: Steven/zeus -->\nCURRENT\n${MARCA_INICIO}\ninside\n`
        + `${MARCA_PERFIL_FIN}\n${MARCA_FIN}\n`,
    },
    {
      name: "reverse overlapping managed blocks",
      file: `${MARCA_INICIO}\n${marcaDeRevisionDelPerfil(11)}\n${MARCA_PERFIL_INICIO}\n`
        + `<!-- alias: Steven/zeus -->\nCURRENT\n${MARCA_FIN}\n${MARCA_PERFIL_FIN}\n`,
    },
  ];
  for (const scenario of cases) {
    writeFileSync(path, scenario.file, "utf8");
    const bytesBeforePreflight = readFileSync(path, "utf8");
    const currentContract = contract(11, [path]);
    const firstDocument = currentContract.documents[0];
    assert.ok(firstDocument, "el contrato no tiene documentos");
    const selectedBySha = scenario.mutateContract
      ? { ...currentContract, documents: [{ ...firstDocument, sha: "f".repeat(64) }] }
      : currentContract;
    const selected = scenario.mutateGeneration
      ? { ...selectedBySha, generation: "another-runtime" }
      : selectedBySha;
    if (scenario.omitFile) rmSync(path, { force: true });
    const { runner, requests } = spyRunner();
    const adapter = new HarnessAdapter({
      definition: definition("claude"),
      runner,
      store: await DurableStore.open(join(root, `state-${scenario.name.replaceAll(" ", "-")}`)),
      environment: nativeEnvironment(),
    });
    await assert.rejects(adapter.execute({
      prompt: "must not run",
      context: {
        ...context("zeus"),
        ...(scenario.omitContract ? {} : { native_profile_contract: selected }),
      },
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(2_000),
    }), (error: unknown) => {
      const expectedCode = scenario.expectedCode ?? "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED";
      assert.equal(profileReloadRequest(nativeEnvironment(), "zeus"), undefined, scenario.name);
      assert.equal((error as { code?: unknown }).code, expectedCode, scenario.name);
      assert.equal((error as { retryable?: unknown }).retryable, scenario.expectedRetryable ?? true, scenario.name);
      return true;
    }, scenario.name);
    assert.equal(requests.length, 0, scenario.name);
    if (scenario.omitFile) {
      assert.equal(existsSync(path), false, scenario.name);
    } else {
      assert.equal(readFileSync(path, "utf8"), bytesBeforePreflight, scenario.name);
    }
  }
});

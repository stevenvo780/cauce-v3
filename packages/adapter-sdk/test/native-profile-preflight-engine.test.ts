import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FICHEROS_OPENCLAW,
  conBloqueDePerfil,
  conBloqueGestionado,
  marcaDeRevisionDelPerfil,
} from "@cauce/protocol";
import { HARNESS_DEFINITIONS, HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import type { HarnessRequestContext } from "../src/contracts/harness.js";
import { textoNativoDelSobre } from "../src/harnesses/shared/prompt.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { AdapterError } from "../src/sdk/errors.js";
import type { DeliveryEvent } from "../src/sdk/types.js";
import { ControlledRunner, delivery, storeFor } from "./engine-fixtures.js";

class FailingNativePreflightHarness extends HarnessAdapter {
  calls = 0;

  override prepareContext(
    context: HarnessRequestContext | undefined,
  ): never {
    this.calls += 1;
    void context;
    throw new AdapterError(
      "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED",
      "injected native profile preflight failure",
      true,
    );
  }
}

class DriftingNativeHarness extends HarnessAdapter {
  executeCalls = 0;

  constructor(
    options: ConstructorParameters<typeof HarnessAdapter>[0],
    private readonly path: string,
  ) {
    super(options);
  }

  override execute(
    request: Parameters<HarnessAdapter["execute"]>[0],
  ): ReturnType<HarnessAdapter["execute"]> {
    this.executeCalls += 1;
    writeFileSync(this.path, `${readFileSync(this.path, "utf8")}\n# Drift before invoke\n`, "utf8");
    return super.execute(request);
  }
}

function nativeEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, CAUCE_NATIVE_PROFILE_CONTEXT: "1" };
}

function profileFile(alias: string, revision: number | undefined, body: string): string {
  const managed = conBloqueDePerfil("", `<!-- alias: Steven/${alias} -->\n${body}`);
  return revision === undefined ? managed : `${marcaDeRevisionDelPerfil(revision)}\n${managed}`;
}

test("native preflight failure remains accepted-side and never commits execution intent", async () => {
  const store = await storeFor("native-preflight-before-barrier");
  const runner = new ControlledRunner();
  const harness = new FailingNativePreflightHarness({ definition: fakeDefinition, runner, store });
  const events: DeliveryEvent[] = [];
  let executionIntents = 0;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => { events.push(event); },
    publishExecutionIntent: async () => { executionIntents += 1; },
  });
  await engine.activateEpoch(1);

  await engine.handleDelivery(delivery("native-preflight-failure"));

  assert.equal(harness.calls, 1);
  assert.equal(runner.calls, 0);
  assert.equal(executionIntents, 0);
  assert.deepEqual(events.map((event) => event.phase), ["accepted", "failed"]);
  assert.equal(events.some((event) => event.phase === "started"), false);
  assert.equal(events.some((event) => event.execution_started === true), false);
  assert.deepEqual(events.at(-1)?.error, {
    code: "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED",
    message: "injected native profile preflight failure",
    retryable: true,
  });
  assert.equal(store.getDelivery("native-preflight-failure")?.state, "failed");
});

test("native drift after accepted preflight fails before execution intent and runner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-engine-drift-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const path = join(config, "CLAUDE.md");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    path,
    profileFile("zeus", 31, "PROFILE-BEFORE-DRIFT"),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-31";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousGeneration === undefined) delete process.env.CAUCE_CONTAINER_GENERATION;
    else process.env.CAUCE_CONTAINER_GENERATION = previousGeneration;
    rmSync(root, { recursive: true, force: true });
  });

  const store = await storeFor("native-preflight-drift-before-intent");
  const runner = new ControlledRunner();
  const harness = new DriftingNativeHarness({
    definition: {
      ...HARNESS_DEFINITIONS.claude,
      sessionStrategy: { kind: "none" },
      parse: () => ({
        output: {
          reply: "completed",
          messages: [],
          notify: [],
          status: "done",
          retryable: false,
          artifacts: [],
        },
      }),
    },
    runner,
    store,
    environment: nativeEnvironment(),
  }, path);
  const events: DeliveryEvent[] = [];
  let executionIntents = 0;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => { events.push(event); },
    publishExecutionIntent: async () => { executionIntents += 1; },
  });
  await engine.activateEpoch(1);
  const input = {
    ...delivery("native-drift"),
    recipient_alias: "zeus",
    profile_runtime_contract: {
      revision: 31,
      generation: "runtime-31",
      documents: [{
        name: "CLAUDE.md",
        path,
        sha: createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex"),
      }],
    },
  };

  await engine.handleDelivery(input);

  assert.equal(harness.executeCalls, 1);
  assert.equal(runner.calls, 0);
  assert.equal(executionIntents, 0);
  assert.deepEqual(events.map((event) => event.phase), ["accepted", "started", "failed"]);
  assert.equal(events.some((event) => event.execution_started === true), false);
  assert.equal(events.at(-1)?.error?.code, "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED");
});

test("native drift while execution intent is confirmed still fails before runner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-intent-drift-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const path = join(config, "CLAUDE.md");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    path,
    profileFile("zeus", 32, "PROFILE-BEFORE-INTENT"),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-32";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousGeneration === undefined) delete process.env.CAUCE_CONTAINER_GENERATION;
    else process.env.CAUCE_CONTAINER_GENERATION = previousGeneration;
    rmSync(root, { recursive: true, force: true });
  });

  const store = await storeFor("native-preflight-drift-during-intent");
  const runner = new ControlledRunner();
  const harness = new HarnessAdapter({
    definition: {
      ...HARNESS_DEFINITIONS.claude,
      sessionStrategy: { kind: "none" },
      parse: () => ({
        output: {
          reply: "completed",
          messages: [],
          notify: [],
          status: "done",
          retryable: false,
          artifacts: [],
        },
      }),
    },
    runner,
    store,
    environment: nativeEnvironment(),
  });
  const events: DeliveryEvent[] = [];
  let intent: DeliveryEvent | undefined;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => { events.push(event); },
    publishExecutionIntent: async (event) => {
      intent = event;
      writeFileSync(path, `${readFileSync(path, "utf8")}\n# Drift during intent\n`, "utf8");
    },
  });
  await engine.activateEpoch(1);
  await engine.handleDelivery({
    ...delivery("native-intent-drift"),
    recipient_alias: "zeus",
    profile_runtime_contract: {
      revision: 32,
      generation: "runtime-32",
      documents: [{
        name: "CLAUDE.md",
        path,
        sha: createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex"),
      }],
    },
  });

  assert.equal(intent?.execution_started, true);
  assert.equal(runner.calls, 0);
  assert.deepEqual(events.map((event) => event.phase), ["accepted", "started", "failed"]);
  assert.equal(events.at(-1)?.error?.code, "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED");
  assert.equal(events.at(-1)?.error?.retryable, true);
});

test("a real native engine turn emits adoption only for its exact measured contract", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-engine-adoption-"));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const path = join(config, "CLAUDE.md");
  mkdirSync(config, { recursive: true });
  const requestContext: HarnessRequestContext = {
    self_alias: "zeus",
    sender_alias: "kant",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: false,
    message_type: "request",
    routing_targets: [],
  };
  writeFileSync(
    path,
    conBloqueGestionado(
      profileFile("zeus", 41, "PROFILE-CLAUDE-BETA"),
      textoNativoDelSobre(requestContext),
    ),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.HOME = home;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-41";
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousGeneration === undefined) delete process.env.CAUCE_CONTAINER_GENERATION;
    else process.env.CAUCE_CONTAINER_GENERATION = previousGeneration;
    rmSync(root, { recursive: true, force: true });
  });

  const store = await storeFor("native-exact-adoption");
  const runner = new ControlledRunner();
  const harness = new HarnessAdapter({
    definition: {
      ...HARNESS_DEFINITIONS.claude,
      sessionStrategy: { kind: "none" },
      parse: () => ({
        output: {
          reply: "completed",
          messages: [],
          notify: [],
          status: "done",
          retryable: false,
          artifacts: [],
        },
      }),
    },
    runner,
    store,
    environment: nativeEnvironment(),
  });
  const events: DeliveryEvent[] = [];
  let executionIntents = 0;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => { events.push(event); },
    publishExecutionIntent: async () => { executionIntents += 1; },
  });
  await engine.activateEpoch(1);
  const document = {
    name: "CLAUDE.md",
    path,
    sha: createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex"),
  };
  await engine.handleDelivery({
    ...delivery("native-adoption"),
    recipient_alias: "zeus",
    body: { prompt: "perform the task", timeout_ms: 2_000 },
    profile_runtime_contract: {
      revision: 41,
      generation: "runtime-41",
      documents: [document],
    },
  });

  assert.equal(executionIntents, 1);
  assert.equal(runner.calls, 1);
  assert.doesNotMatch(runner.requests[0]?.stdin ?? "", /PROFILE-CLAUDE-BETA/u);
  assert.deepEqual(events.map((event) => ({
    phase: event.phase,
    error: event.error?.code,
    adoption: event.profile_adoption,
  })), [
    { phase: "accepted", error: undefined, adoption: undefined },
    { phase: "started", error: undefined, adoption: undefined },
    {
      phase: "done",
      error: undefined,
      adoption: {
        evidence: "adapter_delivery",
        revision: 41,
        generation: "runtime-41",
        documents: [document],
      },
    },
  ]);
  assert.deepEqual(events.at(-1)?.profile_adoption, {
    evidence: "adapter_delivery",
    revision: 41,
    generation: "runtime-41",
    documents: [document],
  });
});

test("a real openclaw engine turn emits adoption for all seven native documents", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-openclaw-adoption-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const requestContext: HarnessRequestContext = {
    self_alias: "argos",
    sender_alias: "kant",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: false,
    message_type: "request",
    routing_targets: [],
  };
  const paths = FICHEROS_OPENCLAW.map((name) => join(workspace, name));
  for (const name of FICHEROS_OPENCLAW) {
    const path = join(workspace, name);
    if (name === "MEMORY.md") writeFileSync(path, "PRIVATE-MEMORY", "utf8");
    else if (name === "HEARTBEAT.md") writeFileSync(path, "PRIVATE-HEARTBEAT", "utf8");
    else {
      const profiled = profileFile(
        "argos",
        name === "AGENTS.md" ? 52 : undefined,
        `PROFILE-OPENCLAW-GAMMA-${name}`,
      );
      writeFileSync(
        path,
        name === "AGENTS.md"
          ? conBloqueGestionado(profiled, textoNativoDelSobre(requestContext))
          : profiled,
        "utf8",
      );
    }
  }
  const previousWorkspace = process.env.CAUCE_OPENCLAW_WORKSPACE;
  const previousGeneration = process.env.CAUCE_CONTAINER_GENERATION;
  process.env.CAUCE_OPENCLAW_WORKSPACE = workspace;
  process.env.CAUCE_CONTAINER_GENERATION = "runtime-52";
  t.after(() => {
    if (previousWorkspace === undefined) delete process.env.CAUCE_OPENCLAW_WORKSPACE;
    else process.env.CAUCE_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousGeneration === undefined) delete process.env.CAUCE_CONTAINER_GENERATION;
    else process.env.CAUCE_CONTAINER_GENERATION = previousGeneration;
    rmSync(root, { recursive: true, force: true });
  });

  const store = await storeFor("native-openclaw-exact-adoption");
  const runner = new ControlledRunner();
  const harness = new HarnessAdapter({
    definition: {
      ...HARNESS_DEFINITIONS.openclaw,
      sessionStrategy: { kind: "none" },
      parse: () => ({
        output: {
          reply: "completed",
          messages: [],
          notify: [],
          status: "done",
          retryable: false,
          artifacts: [],
        },
      }),
    },
    runner,
    store,
    environment: nativeEnvironment(),
  });
  const events: DeliveryEvent[] = [];
  let executionIntents = 0;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => { events.push(event); },
    publishExecutionIntent: async () => { executionIntents += 1; },
  });
  await engine.activateEpoch(1);
  const documents = paths.map((path, index) => ({
    name: FICHEROS_OPENCLAW[index]!,
    path,
    sha: createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex"),
  }));
  await engine.handleDelivery({
    ...delivery("native-openclaw-adoption"),
    recipient_alias: "argos",
    body: { prompt: "perform the OpenClaw task", timeout_ms: 2_000 },
    profile_runtime_contract: {
      revision: 52,
      generation: "runtime-52",
      documents,
    },
  });

  assert.equal(executionIntents, 1);
  assert.equal(runner.calls, 1);
  assert.doesNotMatch(
    runner.requests[0]?.stdin ?? "",
    /PROFILE-OPENCLAW-GAMMA|PRIVATE-MEMORY|PRIVATE-HEARTBEAT/u,
  );
  assert.deepEqual(events.at(-1)?.profile_adoption, {
    evidence: "adapter_delivery",
    revision: 52,
    generation: "runtime-52",
    documents,
  });
});

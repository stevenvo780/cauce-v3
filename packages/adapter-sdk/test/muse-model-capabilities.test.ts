import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@muse-code/sdk";
import { MuseMspFault, type MuseWait } from "../src/sdk/muse-msp-reconciliation.js";
import { MuseMspSession, type MuseMspTelemetry } from "../src/sdk/muse-msp-session.js";

const sessionId = "synthetic-model-session";
const modelId = "muse-spark-1.3";
const wait: MuseWait = async (promise) => promise;
const selected = {
  modelId, providerId: "meta", profileId: "subscription-profile",
  variants: ["high", "max"], defaultReasoningEffort: "high",
};

function fixture(options: {
  catalog?: Record<string, unknown>;
  currentModel?: string;
  modelAck?: Record<string, unknown>;
  approvalAck?: Record<string, unknown>;
} = {}) {
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  const order: string[] = [];
  const telemetry: MuseMspTelemetry[] = [];
  const connection = {
    onNotification: () => undefined,
    onProtocolError: () => undefined,
    closed: new Promise<void>(() => undefined),
    request: async (method: string, params: Record<string, unknown>) => {
      assert.deepEqual(params, method === "session/read"
        ? { sessionId, excludeItems: false } : { sessionId });
      order.push(method);
      if (method === "session/read") return {
        session: { sessionId, modelId: options.currentModel ?? modelId, workspaceRoot: "/synthetic-workspace" },
        viewCursor: "opaque=model-view", history: { mode: "inline", items: [] },
      };
      assert.equal(method, "model/list");
      return options.catalog ?? { models: [selected], source: "providerCatalog" };
    },
    command: async (method: string, params: Record<string, unknown>) => {
      assert.deepEqual(telemetry, []);
      commands.push({ method, params });
      order.push(method);
      if (method === "session/setModel") return options.modelAck ?? { status: "accepted" };
      assert.equal(method, "session/setApprovalMode");
      return options.approvalAck ?? { status: "accepted", effectiveMode: { mode: "denyUnmatched" } };
    },
  } as unknown as Connection;
  const session = new MuseMspSession(connection, sessionId, { kind: "durable" }, (event) => {
    order.push(event.event);
    telemetry.push(event);
  });
  return { session, commands, order, telemetry };
}

test("Muse reports the exact catalog route only after model and approval commands are accepted", async (t) => {
  const { session, commands, order, telemetry } = fixture({ currentModel: "previous-model" });
  t.after(() => { session.close(); });
  const view = await session.configure(modelId, "max", "denyUnmatched", wait);
  assert.deepEqual(commands, [
    { method: "session/setModel", params: {
      sessionId, model: { modelId, providerId: "meta", profileId: "subscription-profile" },
    } },
    { method: "session/setApprovalMode", params: { sessionId, mode: "denyUnmatched" } },
  ]);
  assert.deepEqual(order, [
    "session/read", "model/list", "session/setModel", "session/setApprovalMode", "muse_model_selection",
  ]);
  assert.deepEqual(telemetry, [{
    event: "muse_model_selection", model: modelId, provider: "meta", catalog_source: "providerCatalog",
    requested_effort: "max", supported_efforts: ["high", "max"],
  }]);
  assert.deepEqual(view, { viewCursor: "opaque=model-view", workspace: "/synthetic-workspace" });
});

test("Muse uses the session model when none is requested without inventing verified effort support", async (t) => {
  const { session, commands, telemetry } = fixture({
    currentModel: modelId,
    catalog: {
      models: [
        { modelId: "muse-spark-1.3-contributor", providerId: "meta", profileId: null, variants: ["high"] },
        { modelId, providerId: "meta", profileId: null, variants: "unknown" },
      ],
      source: "bundledCatalog",
    },
  });
  t.after(() => { session.close(); });
  await session.configure(undefined, undefined, "denyUnmatched", wait);
  assert.deepEqual(commands[0], {
    method: "session/setModel", params: { sessionId, model: { modelId, providerId: "meta" } },
  });
  assert.equal(commands.length, 2);
  assert.deepEqual(telemetry, [{
    event: "muse_model_selection", model: modelId, provider: "meta", catalog_source: "bundledCatalog",
  }]);
});

for (const [name, catalog, code] of [
  ["missing requested model", { models: [], source: "providerCatalog" }, "MUSE_MODEL_UNVERIFIED"],
  ["ambiguous provider routes", {
    models: [selected, { ...selected, providerId: "another-provider" }], source: "providerCatalog",
  }, "MUSE_MODEL_UNVERIFIED"],
  ["ambiguous profile routes", {
    models: [selected, { ...selected, profileId: "another-profile" }], source: "providerCatalog",
  }, "MUSE_MODEL_UNVERIFIED"],
  ["default absent from supported efforts", {
    models: [{ ...selected, defaultReasoningEffort: "ultra" }], source: "providerCatalog",
  }, "MUSE_CATALOG_INVALID"],
  ["invalid default effort", {
    models: [{ ...selected, defaultReasoningEffort: "automatic" }], source: "providerCatalog",
  }, "MUSE_CATALOG_INVALID"],
] as const) {
  test(`Muse refuses ${name} before model commands or selection telemetry`, async (t) => {
    const { session, commands, telemetry } = fixture({ catalog });
    t.after(() => { session.close(); });
    await assert.rejects(session.configure(modelId, "high", "denyUnmatched", wait),
      (error: unknown) => error instanceof MuseMspFault && error.code === code);
    assert.deepEqual(commands, []);
    assert.deepEqual(telemetry, []);
  });
}

test("Muse does not change approval mode or report selection after a rejected model command", async (t) => {
  const { session, commands, telemetry } = fixture({ modelAck: { status: "rejected" } });
  t.after(() => { session.close(); });
  await assert.rejects(session.configure(modelId, "high", "denyUnmatched", wait),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_MODEL_UNVERIFIED");
  assert.deepEqual(commands.map(({ method }) => method), ["session/setModel"]);
  assert.deepEqual(telemetry, []);
});

for (const [name, approvalAck] of [
  ["rejected approval command", { status: "rejected", effectiveMode: { mode: "denyUnmatched" } }],
  ["different effective approval mode", { status: "accepted", effectiveMode: { mode: "onRequest" } }],
] as const) {
  test(`Muse withholds selection telemetry after a ${name}`, async (t) => {
    const { session, commands, telemetry } = fixture({ approvalAck });
    t.after(() => { session.close(); });
    await assert.rejects(session.configure(modelId, "high", "denyUnmatched", wait),
      (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_APPROVAL_UNVERIFIED");
    assert.deepEqual(commands.map(({ method }) => method), ["session/setModel", "session/setApprovalMode"]);
    assert.deepEqual(telemetry, []);
  });
}

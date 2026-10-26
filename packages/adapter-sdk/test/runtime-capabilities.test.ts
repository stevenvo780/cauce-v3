import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHarnessDefinition, withContextAdoption, type AgentTurnRunner } from "../src/bin/shared.js";
import { HARNESS_DEFINITIONS, openClawDefinition } from "../src/harnesses/index.js";
import { helloCapabilityStrings } from "../src/sdk/client.js";

const HELLO_SUFFIXES = [
  "console_human_scope_v1",
  "agent_identity_v1",
  "company_context_v1",
  "versioned_context_v1",
  "agent_profile_adoption_v1",
  "agent_profile_v1",
  "client_mailbox_v1",
  "delegation_feedback_v1",
  "heartbeat",
  "mcp_emit",
  "renewable_delivery_claims_v1",
  "routing_targets_v1",
] as const;

const UNNEGOTIATED = [
  "protocol.3.0",
  "structured-output",
  "stdin-prompt",
  "durable-inbox",
  "durable-outbox",
  "idempotent-delivery",
  "cancellation.process-group",
  "fencing-epoch",
  "origin-relay",
  "attempt-scoped-delivery",
  "event-id-correlation",
  "claim-token-correlation",
  "authenticated-session-scope",
  "attachments_v1",
  "native_image_input_v1",
  "native_document_input_v1",
  "persistent-sessions",
  "loopback-api",
  "stable-alias-sessions",
  "api-cancellation.abort-signal",
] as const;

test("hello advertises only capabilities consumed by runtime or operational readers", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    const advertised = helloCapabilityStrings(definition.capabilities);
    const workState = definition.id === 'openclaw' || definition.id === 'grok' ? ['conversation_work_v1'] : [];
    assert.deepEqual(
      [...advertised].sort(),
      [`harness.${definition.id}`, ...HELLO_SUFFIXES, ...workState].sort(),
      definition.id,
    );
    assert.equal(advertised.length, 13 + workState.length, definition.id);
    assert.equal(new Set(advertised).size, advertised.length, definition.id);
  }
});

test("hello retains heartbeat for operational lease readers", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    assert.equal(definition.capabilities.heartbeat, true, definition.id);
    assert.equal(helloCapabilityStrings(definition.capabilities).includes("heartbeat"), true, definition.id);
  }
});

test("local implementation details never leak into the hello surface", () => {
  const definition = runtimeHarnessDefinition("openclaw", openClawDefinition, "api");
  const advertised = helloCapabilityStrings({
    ...definition.capabilities,
    native_image_input_v1: true,
    native_document_input_v1: true,
  });

  for (const capability of UNNEGOTIATED) {
    assert.equal(advertised.includes(capability), false, capability);
  }
  assert.equal(definition.capabilities.loopback_api, true);
  assert.equal(definition.capabilities.api_cancellation, "abort_signal");
});

test("transport selection changes runtime behavior without inventing hello negotiation", () => {
  const cli = runtimeHarnessDefinition("openclaw", openClawDefinition, "cli");
  const api = runtimeHarnessDefinition("openclaw", openClawDefinition, "api");

  assert.equal(cli.capabilities.loopback_api, undefined);
  assert.equal(api.capabilities.loopback_api, true);
  assert.deepEqual(helloCapabilityStrings(cli.capabilities), helloCapabilityStrings(api.capabilities));
  assert.deepEqual(
    helloCapabilityStrings(runtimeHarnessDefinition("openclaw", openClawDefinition, undefined).capabilities),
    helloCapabilityStrings(cli.capabilities),
  );
});


test("human initiator capability is absent by default and explicit only for the complete consumer", () => {
  const capabilities = HARNESS_DEFINITIONS.claude.capabilities;
  assert.equal(helloCapabilityStrings(capabilities).includes("human_message_initiator_v1"), false);
  const enabled = helloCapabilityStrings(capabilities, true);
  assert.equal(enabled.filter((capability) => capability === "human_message_initiator_v1").length, 1);
  assert.deepEqual(enabled.filter((capability) => ![
    "human_message_initiator_v1", "human_message_client_provenance_v1", "human_message_client_delegation_v1",
  ].includes(capability)),
    helloCapabilityStrings(capabilities));
});


test("client HELLO follows the immutable factory capability for supported and unsupported harnesses", async (t) => {
  const { isolatedEngine } = await import("./human-initiator-session-isolation.fixtures.js");
  const { FakeConnection, waitUntil } = await import("./client-fixtures.js");
  const { AdapterClient } = await import("../src/sdk/client.js");
  const { deliveryHarnesses } = await import("../src/bin/shared.js");
  for (const definition of [HARNESS_DEFINITIONS.claude, HARNESS_DEFINITIONS.codex, HARNESS_DEFINITIONS.muse, HARNESS_DEFINITIONS.grok, HARNESS_DEFINITIONS.fake]) {
    const context = await isolatedEngine(t);
    const connection = new FakeConnection(1);
    const adapters = deliveryHarnesses({ definition, runner: context.manual, store: context.store, sessionNamespace: "argos" }, context.headless);
    const client = new AdapterClient({ config: { tenantId: "Steven", alias: "argos", instanceId: "human-sdk-client",
      stateDirectory: context.directory }, connector: { connect: async () => connection }, store: context.store, ...adapters });
    const stop = new AbortController();
    const running = client.run(stop.signal);
    try {
      await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "HELLO capability");
      const hello = connection.sent.find((frame) => frame.type === "hello");
      assert.ok(hello);
      assert.equal(hello.capabilities.includes("human_message_initiator_v1"), definition.id !== "fake");
      assert.equal(hello.capabilities.includes("human_message_client_provenance_v1"), definition.id !== "fake");
      assert.equal(hello.capabilities.includes("human_message_client_delegation_v1"), definition.id !== "fake");
    } finally { stop.abort(); await running; }
  }
});

test("context adoption is announced only by runners whose agent turns return a consumption witness", () => {
  const expected: Readonly<Record<AgentTurnRunner, readonly string[]>> = {
    process: ["claude", "codex", "grok", "openclaw"],
    shared: ["claude", "codex", "muse"],
    "openclaw-api": [],
    "muse-msp": [],
  };
  for (const [runner, harnesses] of Object.entries(expected) as [AgentTurnRunner, readonly string[]][]) {
    for (const definition of Object.values(HARNESS_DEFINITIONS)) {
      const advertised = helloCapabilityStrings(withContextAdoption(definition, runner).capabilities);
      assert.equal(advertised.includes("context_adoption_v1"), harnesses.includes(definition.id), `${runner} ${definition.id}`);
      assert.deepEqual(advertised.filter((capability) => capability !== "context_adoption_v1"),
        helloCapabilityStrings(definition.capabilities), `${runner} ${definition.id}`);
    }
  }
  // The packaged definitions never claim it: only the runtime that knows its runner may.
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    assert.equal(definition.capabilities.context_adoption_v1, undefined, definition.id);
  }
});

test("an adapter without versioned context never announces context adoption", () => {
  const { versioned_context_v1: _versioned, ...capabilities } = HARNESS_DEFINITIONS.codex.capabilities;
  void _versioned;
  const definition = { ...HARNESS_DEFINITIONS.codex, capabilities };
  assert.equal(withContextAdoption(definition, "process").capabilities.context_adoption_v1, undefined);
});

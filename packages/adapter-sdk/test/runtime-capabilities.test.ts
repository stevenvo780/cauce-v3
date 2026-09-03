import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHarnessDefinition } from "../src/bin/shared.js";
import { HARNESS_DEFINITIONS, openClawDefinition } from "../src/harnesses/index.js";
import { helloCapabilityStrings } from "../src/sdk/client.js";

const HELLO_SUFFIXES = [
  "agent_identity_v1",
  "agent_profile_adoption_v1",
  "agent_profile_v1",
  "delegation_feedback_v1",
  "heartbeat",
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
    assert.deepEqual(
      [...advertised].sort(),
      [`harness.${definition.id}`, ...HELLO_SUFFIXES].sort(),
      definition.id,
    );
    assert.equal(advertised.length, 8, definition.id);
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

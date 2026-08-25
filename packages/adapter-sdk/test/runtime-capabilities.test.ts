import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHarnessDefinition } from "../src/bin/shared.js";
import { HARNESS_DEFINITIONS, openClawDefinition } from "../src/harnesses/index.js";
import { capabilityStrings } from "../src/sdk/client.js";
import type { AdapterCapabilities } from "../src/sdk/types.js";

function cuentaDeclaradas(capabilities: AdapterCapabilities): number {
  return Object.values(capabilities).filter((value) => value !== false && value !== undefined).length;
}

test("every declared runtime capability has exactly one hello string", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    const advertised = capabilityStrings(definition.capabilities);
    assert.equal(advertised.length, cuentaDeclaradas(definition.capabilities), definition.id);
    assert.equal(new Set(advertised).size, advertised.length, `${definition.id} duplicated a capability`);
    assert.equal(advertised.includes("agent_profile_v1"), true, definition.id);
  }
});

test("optional media and transport declarations are not omitted", () => {
  const capabilities: AdapterCapabilities = {
    ...HARNESS_DEFINITIONS.fake.capabilities,
    native_image_input_v1: true,
    native_document_input_v1: true,
    loopback_api: true,
    stable_alias_sessions: true,
    api_cancellation: "abort_signal",
  };
  const advertised = capabilityStrings(capabilities);

  assert.equal(advertised.length, cuentaDeclaradas(capabilities));
  for (const capability of [
    "stdin-prompt",
    "idempotent-delivery",
    "heartbeat",
    "cancellation.process-group",
    "origin-relay",
    "attachments_v1",
    "native_image_input_v1",
    "native_document_input_v1",
    "agent_profile_v1",
    "loopback-api",
    "stable-alias-sessions",
    "api-cancellation.abort-signal",
  ]) {
    assert.equal(advertised.includes(capability), true, `hello omitted ${capability}`);
  }
});

test("every bundled adapter advertises routing_targets_v1 before receiving trusted inventory", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    assert.equal(definition.capabilities.routing_targets_v1, true);
    assert.equal(capabilityStrings(definition.capabilities).includes("routing_targets_v1"), true);
  }
});

test("every bundled adapter advertises renewable delivery claims", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    assert.equal(definition.capabilities.renewable_delivery_claims_v1, true);
    assert.equal(
      capabilityStrings(definition.capabilities).includes("renewable_delivery_claims_v1"),
      true,
    );
  }
});

test("OpenClaw CLI advertises stable sessions without API-only capabilities", () => {
  const definition = runtimeHarnessDefinition("openclaw", openClawDefinition, "cli");
  const advertised = capabilityStrings(definition.capabilities);

  assert.equal(advertised.includes("persistent-sessions"), true);
  assert.equal(advertised.includes("stable-alias-sessions"), true);
  assert.equal(advertised.includes("loopback-api"), false);
  assert.equal(advertised.includes("api-cancellation.abort-signal"), false);

  assert.deepEqual(
    capabilityStrings(runtimeHarnessDefinition("openclaw", openClawDefinition, undefined).capabilities),
    advertised,
    "omitting OpenClaw transport must fail closed to CLI capabilities",
  );
  assert.equal(openClawDefinition.capabilities.loopback_api, true);
  assert.equal(openClawDefinition.capabilities.api_cancellation, "abort_signal");
});

test("OpenClaw API advertises stable sessions and API-only capabilities", () => {
  const definition = runtimeHarnessDefinition("openclaw", openClawDefinition, "api");
  const advertised = capabilityStrings(definition.capabilities);

  assert.equal(advertised.includes("persistent-sessions"), true);
  assert.equal(advertised.includes("stable-alias-sessions"), true);
  assert.equal(advertised.includes("loopback-api"), true);
  assert.equal(advertised.includes("api-cancellation.abort-signal"), true);
});

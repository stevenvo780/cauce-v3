import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHarnessDefinition } from "../src/bin/shared.js";
import { HARNESS_DEFINITIONS, openClawDefinition } from "../src/harnesses/index.js";
import { capabilityStrings } from "../src/sdk/client.js";

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

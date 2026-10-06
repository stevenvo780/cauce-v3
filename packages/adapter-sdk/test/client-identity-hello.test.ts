import assert from "node:assert/strict";
import test from "node:test";
import {
  HUMAN_CLIENT_PROVENANCE_CAPABILITY,
  HUMAN_CLIENT_DELEGATION_CAPABILITY,
} from "@cauce/protocol";
import { capabilities, helloCapabilityStrings } from "../src/harnesses/shared.js";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import type { AdapterCapabilities } from "../src/sdk/types.js";

function without(...keys: (keyof AdapterCapabilities)[]): AdapterCapabilities {
  const removed = new Set<string>(keys);
  return Object.fromEntries(Object.entries(HARNESS_DEFINITIONS.claude.capabilities)
    .filter(([key]) => !removed.has(key))) as unknown as AdapterCapabilities;
}

test("HELLO caps for client identity are advertised only when the runtime declares support", () => {
  const noCaps = without("human_message_client_provenance_v1", "human_message_client_delegation_v1");
  const advertised = helloCapabilityStrings(noCaps, true);
  assert.equal(advertised.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY), false);
  assert.equal(advertised.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY), false);

  const withProvenance: AdapterCapabilities = {
    ...without("human_message_client_delegation_v1"),
    human_message_client_provenance_v1: true,
  };
  const withProvAdvertised = helloCapabilityStrings(withProvenance, true);
  assert.equal(withProvAdvertised.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY), true);
  assert.equal(withProvAdvertised.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY), false);
  assert.equal(withProvAdvertised.filter((value) => value === HUMAN_CLIENT_PROVENANCE_CAPABILITY).length, 1);

  const withBoth: AdapterCapabilities = {
    ...HARNESS_DEFINITIONS.claude.capabilities,
    human_message_client_provenance_v1: true,
    human_message_client_delegation_v1: true,
  };
  const bothAdvertised = helloCapabilityStrings(withBoth, true);
  assert.equal(bothAdvertised.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY), true);
  assert.equal(bothAdvertised.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY), true);
});

test("the packaged capability factory declares both client identity caps for every harness", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    const built = capabilities(definition.id, true,
      definition.id === "fake" ? {} : { stable_alias_sessions: true });
    assert.equal(built.human_message_client_provenance_v1, true, definition.id);
    assert.equal(built.human_message_client_delegation_v1, true, definition.id);
    const advertised = helloCapabilityStrings(built, true);
    assert.equal(advertised.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY), true, definition.id);
    assert.equal(advertised.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY), true, definition.id);
  }
});

test("HELLO caps are absent when the harness capability flags are not set", () => {
  const base: AdapterCapabilities = without("human_message_client_provenance_v1",
    "human_message_client_delegation_v1");
  const advertised = helloCapabilityStrings(base, true);
  assert.equal(advertised.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY), false);
  assert.equal(advertised.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY), false);
});

test("client metadata is never negotiated without human session isolation", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    const advertised = helloCapabilityStrings(definition.capabilities, false);
    for (const cap of [HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY,
      'human_message_initiator_v1']) assert.equal(advertised.includes(cap), false);
  }
});

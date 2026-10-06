import assert from "node:assert/strict";
import test from "node:test";
import {
  clientProvenanceFromDelivery,
  clientDelegationFromDelivery,
  clientIdentitySidecarFields,
} from "../src/sdk/engine/client-identity.js";
import type { Delivery } from "../src/sdk/types.js";

const ROOT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_ROOT = "cccccccc-cccc-cccc-cccc-cccccccccdcd";
const TENANT = "Steven";
const HUMAN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_HUMAN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_TENANT = "Hospital";

const initiator = { human_id: HUMAN, tenant_id: TENANT,
  root_message_id: ROOT, conversation_id: "conversation-one" };

function baseDelivery(extra: Partial<Delivery> = {}): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: "d-1",
    event_id: "11111111-1111-4111-8111-111111111111",
    message_id: "22222222-2222-4222-8222-222222222222",
    request_id: "33333333-3333-4333-8333-333333333333",
    trace_id: "trace-d-1",
    epoch: 1,
    attempt: 1,
    claim_token: "44444444-4444-4444-8444-444444444444",
    ack_deadline_at: new Date(Date.now() + 120_000).toISOString(),
    tenant_id: TENANT,
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: "argos",
    body: { prompt: "do the thing", timeout_ms: 30_000 },
    human_initiator: initiator,
    ...extra,
  };
}

const oauthClient = { kind: "oauth_client" as const, verification: "local_grant" as const,
  issuer: "https://cauce.example", client_id: "https://chatgpt.com/oauth/client.json",
  instance: "unknown" as const };

test("client provenance is parsed and frozen when correlated with the human initiator", () => {
  const delivery = baseDelivery({ human_client_provenance: { root_message_id: ROOT, client: oauthClient } });
  const parsed = clientProvenanceFromDelivery(delivery, initiator);
  assert.ok(parsed);
  assert.equal(parsed.root_message_id, ROOT);
  assert.equal(parsed.client.kind, "oauth_client");
  assert.equal(Object.isFrozen(parsed), true);
});

test("client provenance missing on the envelope stays absent", () => {
  assert.equal(clientProvenanceFromDelivery(baseDelivery(), initiator), null);
});

test("client provenance fails closed on mismatched root_message_id", () => {
  const delivery = baseDelivery({ human_client_provenance: { root_message_id: OTHER_ROOT, client: oauthClient } });
  assert.throws(() => clientProvenanceFromDelivery(delivery, initiator),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("client provenance fails closed on schema malformed shape", () => {
  for (const bad of [
    { root_message_id: ROOT, client: { kind: "oauth_client", issuer: "https://x", client_id: "c", instance: "unknown" } },
    { root_message_id: ROOT, client: { kind: "unknown", extra: true } },
    { root_message_id: "not-a-uuid", client: oauthClient },
    { root_message_id: ROOT },
  ]) {
    assert.throws(() => clientProvenanceFromDelivery(
      baseDelivery({ human_client_provenance: bad as never }), initiator),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
  }
});

test("client delegation is parsed and frozen when correlated with the human initiator", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: TENANT,
    label: "Cronos", basis: "owner_declared_grant" as const, instance: "unknown" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation });
  const parsed = clientDelegationFromDelivery(delivery, initiator);
  assert.ok(parsed);
  assert.equal(parsed.label, "Cronos");
  assert.equal(parsed.basis, "owner_declared_grant");
  assert.equal(parsed.instance, "unknown");
  assert.equal(Object.isFrozen(parsed), true);
});

test("client delegation fails closed when owner_human_id does not match the initiator", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: OTHER_HUMAN, owner_tenant_id: TENANT,
    label: "Cronos", basis: "owner_declared_grant" as const, instance: "unknown" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation });
  assert.throws(() => clientDelegationFromDelivery(delivery, initiator),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("client delegation fails closed when owner_tenant_id does not match the initiator tenant", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: OTHER_TENANT,
    label: "Cronos", basis: "owner_declared_grant" as const, instance: "unknown" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation });
  assert.throws(() => clientDelegationFromDelivery(delivery, initiator),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("client delegation fails closed when basis is not owner_declared_grant", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: TENANT,
    label: "Cronos", basis: "spoofed" as const, instance: "unknown" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation as never });
  assert.throws(() => clientDelegationFromDelivery(delivery, initiator),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("client delegation fails closed when instance claims anything other than unknown", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: TENANT,
    label: "Cronos", basis: "owner_declared_grant" as const, instance: "verified" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation as never });
  assert.throws(() => clientDelegationFromDelivery(delivery, initiator),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("client delegation fails closed when the human initiator is absent", () => {
  const delegation = { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: TENANT,
    label: "Cronos", basis: "owner_declared_grant" as const, instance: "unknown" as const };
  const delivery = baseDelivery({ human_client_delegation: delegation, human_initiator: undefined });
  assert.throws(() => clientDelegationFromDelivery(delivery, undefined),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_DELIVERY");
});

test("body and origin fields are not consulted to fabricate client identity", () => {
  const delivery = baseDelivery({
    body: { prompt: "do the thing", client: oauthClient },
    origin: { adapter: "mcp", channel: "mcp", conversation_id: "c-1", relay: [], metadata: { client: oauthClient } },
    authenticated_context: { session_id: "s-1", channel: "mcp", origin: {
      adapter: "mcp", channel: "mcp", conversation_id: "c-1", relay: [], metadata: { client: oauthClient },
    } },
  });
  assert.equal(clientProvenanceFromDelivery(delivery, initiator), null);
  assert.equal(clientDelegationFromDelivery(delivery, initiator), null);
});

test("client metadata follows the configured recipient tenant, not the descendant sender", () => {
  const proof = { root_message_id: ROOT, client: oauthClient };
  const delivered = baseDelivery({ tenant_id: 'Jhon', human_client_provenance: proof });
  assert.deepEqual(clientIdentitySidecarFields(delivered, initiator, 'Steven').clientProvenance, proof);
  for (const ownTenant of [undefined, 'Jhon']) {
    assert.throws(() => clientIdentitySidecarFields(delivered, initiator, ownTenant), { code: 'INVALID_DELIVERY' });
  }
  assert.deepEqual(clientIdentitySidecarFields(baseDelivery(), initiator, undefined), {});
});

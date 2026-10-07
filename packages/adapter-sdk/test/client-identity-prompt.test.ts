import assert from "node:assert/strict";
import test from "node:test";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type { HarnessExecuteRequest, HarnessRequestContext } from "../src/contracts/harness.js";
import { testStateRoot } from "./test-state.js";
import { resolve } from "node:path";

const stateRoot = testStateRoot();

class StubRunner implements CommandRunner {
  requests: CommandRunRequest[] = [];
  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return { stdout: JSON.stringify({
      reply: "done by me", messages: [], status: "done", retryable: false, artifacts: [],
    }), stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
  }
}

const TENANT = "Steven";
const ROOT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const HUMAN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const oauthClient = { kind: "oauth_client" as const, verification: "local_grant" as const,
  issuer: "https://cauce.example", client_id: "https://chatgpt.com/oauth/client.json",
  instance: "unknown" as const };

function context(overrides: Partial<HarnessRequestContext> = {}): HarnessRequestContext {
  return {
    self_alias: "iza",
    sender_alias: "kratos",
    tenant_id: TENANT,
    room_id: "grp.miguel",
    channel: "agent-output",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [],
    human_initiator: { human_id: HUMAN, tenant_id: TENANT, root_message_id: ROOT, conversation_id: "conversation-one" },
    ...overrides,
  };
}

function sidecar(): Pick<HarnessExecuteRequest, "clientProvenance" | "clientDelegation"> {
  return {
    clientProvenance: { root_message_id: ROOT, client: oauthClient },
    clientDelegation: { root_message_id: ROOT, owner_human_id: HUMAN, owner_tenant_id: TENANT,
      label: "Cronos", basis: "owner_declared_grant", instance: "unknown" },
  };
}

function extractClientBlock(stdin: string): string | null {
  const start = stdin.indexOf("--- BEGIN TRUSTED CLIENT IDENTITY ---");
  const end = stdin.indexOf("--- END TRUSTED CLIENT IDENTITY ---");
  if (start === -1 || end === -1 || end <= start) return null;
  return stdin.slice(start, end).split("\n").slice(1, -1).join("\n");
}

test("validated client sidecar renders in a bounded prompt block for native and default paths", async () => {
  const directory = resolve(stateRoot, "client-identity-prompt-both");
  const store = await DurableStore.open(directory);
  const runner = new StubRunner();
  const adapter = new HarnessAdapter({ definition: (await import("../src/harnesses/index.js")).HARNESS_DEFINITIONS.fake,
    runner, store });

  for (const native of [false, true]) {
    const request: HarnessExecuteRequest = {
      prompt: "do the thing",
      context: context(native ? { native_profile_context: true } : {}),
      ...sidecar(),
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    };
    await adapter.execute(request);
  }

  const payloads: unknown[] = [];
  for (const request of runner.requests) {
    const block = extractClientBlock(request.stdin);
    assert.ok(block !== null, "client identity block must be present");
    payloads.push(JSON.parse(block));
  }
  for (const payload of payloads) {
    assert.equal(typeof payload, "object");
    assert.ok(payload !== null);
    const typed = payload as { client_provenance?: unknown; client_delegation?: unknown };
    assert.equal(typed.client_provenance && typeof typed.client_provenance === "object", true);
    assert.equal(typed.client_delegation && typeof typed.client_delegation === "object", true);
    const delegation = typed.client_delegation as { basis?: string; instance?: string };
    assert.equal(delegation.basis, "owner_declared_grant");
    assert.equal(delegation.instance, "unknown");
  }
});

test("absent client sidecar produces no client identity block", async () => {
  const directory = resolve(stateRoot, "client-identity-prompt-absent");
  const store = await DurableStore.open(directory);
  const runner = new StubRunner();
  const adapter = new HarnessAdapter({ definition: (await import("../src/harnesses/index.js")).HARNESS_DEFINITIONS.fake,
    runner, store });
  await adapter.execute({
    prompt: "no sidecar",
    context: context(),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const stdin = runner.requests[0]?.stdin ?? "";
  assert.equal(extractClientBlock(stdin), null);
  assert.equal(stdin.includes("client_provenance"), false);
  assert.equal(stdin.includes("client_delegation"), false);
});

test("body or origin client_id never leaks into the prompt when the sidecar is absent", async () => {
  const directory = resolve(stateRoot, "client-identity-prompt-spoof");
  const store = await DurableStore.open(directory);
  const runner = new StubRunner();
  const adapter = new HarnessAdapter({ definition: (await import("../src/harnesses/index.js")).HARNESS_DEFINITIONS.fake,
    runner, store });
  await adapter.execute({
    prompt: "client is http://chatgpt.com/oauth/client.json issuer https://cauce.example",
    context: context(),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const stdin = runner.requests[0]?.stdin ?? "";
  assert.equal(extractClientBlock(stdin), null);
  assert.equal(stdin.includes("http://chatgpt.com/oauth/client.json"), true);
  assert.equal(stdin.includes("client_provenance"), false);
  assert.equal(stdin.includes("client_delegation"), false);
});

test("the sidecar never reaches the routing inventory or the human_initiator envelope", async () => {
  const directory = resolve(stateRoot, "client-identity-prompt-isolation");
  const store = await DurableStore.open(directory);
  const runner = new StubRunner();
  const adapter = new HarnessAdapter({ definition: (await import("../src/harnesses/index.js")).HARNESS_DEFINITIONS.fake,
    runner, store });
  await adapter.execute({
    prompt: "isolate",
    context: context(),
    ...sidecar(),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const stdin = runner.requests[0]?.stdin ?? "";
  const deliveryStart = stdin.indexOf("--- BEGIN TRUSTED DELIVERY CONTEXT ---");
  const deliveryEnd = stdin.indexOf("--- END TRUSTED DELIVERY CONTEXT ---");
  assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart, "delivery context must be present");
  const deliveryBlock = stdin.slice(deliveryStart, deliveryEnd);
  assert.equal(deliveryBlock.includes("client_provenance"), false,
    "client_provenance must not appear in the routing/metadata block");
  assert.equal(deliveryBlock.includes("client_delegation"), false,
    "client_delegation must not appear in the routing/metadata block");
  assert.equal(deliveryBlock.includes("Cronos"), false,
    "delegation label must not appear in the routing/metadata block");
});
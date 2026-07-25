import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  HarnessAdapter,
  fakeDefinition,
} from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
  StructuredOutput,
} from "../src/sdk/types.js";

const root = resolve(".test-state-agent-chain");

async function storeFor(name: string): Promise<DurableStore> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

function claimToken(attempt: number, variant = 0): string {
  return `20000000-0000-4000-${8000 + variant}-${String(attempt).padStart(12, "0")}`;
}

function delivery(id: string, epoch = 1, attempt = 1, claim = claimToken(attempt), traceId = `trace-${id}`): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: traceId,
    epoch,
    attempt,
    claim_token: claim,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "jarvis",
    recipient_alias: "argos",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-42",
      external_message_id: "message-9",
      relay: [],
      metadata: {},
    },
    body: { prompt: "check delegation status", timeout_ms: 2_000 },
  };
}

class MockChainRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];
  stdout: string;

  constructor(stdout: string) {
    this.stdout = stdout;
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return {
      stdout: this.stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

test("agent-chain tools - process get_agent_chain_status request", async () => {
  const directory = resolve(root, "test-chain-status");
  await rm(directory, { recursive: true, force: true });
  const store = await storeFor("test-chain-status");
  const events: DeliveryEvent[] = [];

  const chainData = {
    edges: [
      {
        source_alias: "jarvis",
        target_alias: "argos",
        status: "done",
      },
    ],
  };

  const harnessOutput: StructuredOutput = {
    reply: "Checked delegation status",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    tools: [
      {
        id: "tool-1",
        name: "get_agent_chain_status",
        arguments: { trace_id: "trace-d1" },
      },
    ],
  };

  const runner = new MockChainRunner(JSON.stringify(harnessOutput));
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });

  let getAgentChainCalls = 0;
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
    getAgentChain: async (traceId: string) => {
      getAgentChainCalls += 1;
      assert.equal(traceId, "trace-d1", "Should query the correct trace ID");
      return chainData;
    },
  });

  await engine.activateEpoch(1);
  const d = delivery("d1", 1, 1, claimToken(1), "trace-d1");
  await engine.handleDelivery(d);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getAgentChainCalls, 1, "getAgentChain handler should be called once");
  const doneEvents = events.filter((e) => e.phase === "done");
  assert.equal(doneEvents.length, 1, "Should emit one done event");

  const output = doneEvents[0]!.output;
  assert.ok(output, "Output should exist");
  const tools = output!.tools;
  assert.ok(tools, "Output should include tools field");
  assert.equal(tools.length, 1, "Should have one tool response");
  const firstTool = tools[0]!;
  assert.equal(firstTool.id, "tool-1", "Tool response ID should match request");
  assert.equal(firstTool.name, "get_agent_chain_status", "Tool name should match");
  const tool = firstTool as any;
  assert.ok("result" in tool, "Tool should have result field (response not request)");
  assert.deepEqual(tool.result, chainData, "Tool result should contain chain data");
});

test("agent-chain tools - missing trace_id argument returns error", async () => {
  const directory = resolve(root, "test-missing-trace-id");
  await rm(directory, { recursive: true, force: true });
  const store = await storeFor("test-missing-trace-id");
  const events: DeliveryEvent[] = [];

  const harnessOutput: StructuredOutput = {
    reply: "Checked status",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    tools: [
      {
        id: "tool-2",
        name: "get_agent_chain_status",
        arguments: {},
      },
    ],
  };

  const runner = new MockChainRunner(JSON.stringify(harnessOutput));
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });

  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
    getAgentChain: async () => {
      throw new Error("Should not be called");
    },
  });

  await engine.activateEpoch(1);
  const d = delivery("d2");
  await engine.handleDelivery(d);

  await new Promise((resolve) => setImmediate(resolve));

  const doneEvents = events.filter((e) => e.phase === "done");
  assert.equal(doneEvents.length, 1);

  const output = doneEvents[0]!.output;
  assert.ok(output);
  const tools = output.tools;
  assert.ok(tools);
  assert.equal(tools.length, 1);
  const firstTool = tools[0]!;
  assert.equal(firstTool.id, "tool-2");
  const tool = firstTool as any;
  assert.ok(tool.error, "Should contain error message");
  assert.match(tool.error, /trace_id/i);
});

test("agent-chain tools - unknown tool returns error", async () => {
  const directory = resolve(root, "test-unknown-tool");
  await rm(directory, { recursive: true, force: true });
  const store = await storeFor("test-unknown-tool");
  const events: DeliveryEvent[] = [];

  const harnessOutput: StructuredOutput = {
    reply: "Done",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    tools: [
      {
        id: "tool-3",
        name: "unknown_tool",
        arguments: {},
      },
    ],
  };

  const runner = new MockChainRunner(JSON.stringify(harnessOutput));
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });

  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
  });

  await engine.activateEpoch(1);
  const d = delivery("d3");
  await engine.handleDelivery(d);

  await new Promise((resolve) => setImmediate(resolve));

  const doneEvents = events.filter((e) => e.phase === "done");
  const output = doneEvents[0]!.output;
  assert.ok(output);
  assert.ok(output.tools);
  const tool = output.tools![0] as any;
  assert.ok(tool.error);
  assert.match(tool.error, /Unknown tool/);
});

test("agent-chain tools - no handler returns error for known tools", async () => {
  const directory = resolve(root, "test-no-handler");
  await rm(directory, { recursive: true, force: true });
  const store = await storeFor("test-no-handler");
  const events: DeliveryEvent[] = [];

  const harnessOutput: StructuredOutput = {
    reply: "Done",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    tools: [
      {
        id: "tool-4",
        name: "get_agent_chain_status",
        arguments: { trace_id: "trace-d4" },
      },
    ],
  };

  const runner = new MockChainRunner(JSON.stringify(harnessOutput));
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });

  // Engine without getAgentChain handler
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
  });

  await engine.activateEpoch(1);
  const d = delivery("d4");
  await engine.handleDelivery(d);

  await new Promise((resolve) => setImmediate(resolve));

  const doneEvents = events.filter((e) => e.phase === "done");
  const output = doneEvents[0]!.output;
  assert.ok(output);
  // Without handler, known tools should return error
  assert.ok(output.tools);
  const firstTool = output.tools![0]!;
  const tool = firstTool as any;
  assert.ok(tool.error, "Should contain error for missing handler");
  assert.match(tool.error, /not available/);
});

test("agent-chain tools - handler error is captured", async () => {
  const directory = resolve(root, "test-handler-error");
  await rm(directory, { recursive: true, force: true });
  const store = await storeFor("test-handler-error");
  const events: DeliveryEvent[] = [];

  const harnessOutput: StructuredOutput = {
    reply: "Done",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    tools: [
      {
        id: "tool-5",
        name: "get_agent_chain_status",
        arguments: { trace_id: "trace-error" },
      },
    ],
  };

  const runner = new MockChainRunner(JSON.stringify(harnessOutput));
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });

  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
    getAgentChain: async () => {
      throw new Error("Database connection failed");
    },
  });

  await engine.activateEpoch(1);
  const d = delivery("d5");
  await engine.handleDelivery(d);

  await new Promise((resolve) => setImmediate(resolve));

  const doneEvents = events.filter((e) => e.phase === "done");
  const output = doneEvents[0]!.output;
  assert.ok(output);
  assert.ok(output.tools);
  const tool = output.tools![0] as any;
  assert.equal(tool.error, "Database connection failed");
});

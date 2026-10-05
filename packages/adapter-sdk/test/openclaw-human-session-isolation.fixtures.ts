import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openClawDefinition } from "../src/harnesses/index.js";
import { deliveryHarnesses } from "../src/bin/shared.js";
import { OpenClawApiRunner } from "../src/sdk/openclaw-api-runner.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { humanHarnessSelector } from "../src/sdk/engine/delivery-context.js";
import type { Delivery, DeliveryEvent, CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type { HarnessAdapterOptions } from "../src/contracts/harness.js";
import { testStateRoot } from "./test-state.js";

export interface CapturedOpenClawRequest {
  readonly model: unknown;
  readonly user: unknown;
  readonly content: unknown;
}

export interface OpenClawApiFixture {
  readonly endpoint: string;
  readonly requests: CapturedOpenClawRequest[];
  waitForRequests(count: number): Promise<void>;
  waitForDisconnect(user: unknown): Promise<void>;
  respond(user: unknown): void;
  close(): Promise<void>;
}

function apiResponse(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    reply: "synthetic loopback response",
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [],
  }));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

export async function openOpenClawApiFixture(options: { readonly holdResponses?: boolean } = {}): Promise<OpenClawApiFixture> {
  const requests: CapturedOpenClawRequest[] = [];
  const pending = new Map<unknown, ServerResponse>();
  const disconnected = new Set<unknown>();
  const server: Server = createServer(async (request, response) => {
    const chunks: string[] = [];
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    const body = JSON.parse(chunks.join("")) as {
      model?: unknown;
      user?: unknown;
      messages?: readonly { content?: unknown }[];
    };
    const user = body.user;
    requests.push({ model: body.model, user, content: body.messages?.[0]?.content });
    response.once("close", () => {
      pending.delete(user);
      if (!response.writableEnded) disconnected.add(user);
    });
    if (options.holdResponses === true) {
      pending.set(user, response);
      return;
    }
    apiResponse(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    requests,
    waitForRequests: async (count) => waitFor(() => requests.length >= count, `${String(count)} API requests`),
    waitForDisconnect: async (user) => waitFor(() => disconnected.has(user), "cancelled API request disconnect"),
    respond(user) {
      const response = pending.get(user);
      assert.ok(response, "the loopback request is still pending");
      pending.delete(user);
      apiResponse(response);
    },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      for (const response of pending.values()) apiResponse(response);
      pending.clear();
      server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      });
    }),
  };
}

export class CapturingOpenClawCliRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return {
      stdout: JSON.stringify({ reply: "synthetic CLI response", messages: [], status: "done", retryable: false, artifacts: [] }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

export async function createOpenClawHarnesses(options: {
  readonly stateDirectory: string;
  readonly endpoint?: string;
  readonly runner?: CommandRunner;
  readonly store?: DurableStore;
  readonly commandOverride?: HarnessAdapterOptions["commandOverride"];
  readonly recipientAlias?: string;
}) {
  const directory = join(options.stateDirectory, "token");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenFile = join(directory, "api-token");
  await writeFile(tokenFile, "fixture-token\n", { mode: 0o600 });
  const store = options.store ?? await DurableStore.open(join(options.stateDirectory, "store"));
  const runner = options.runner ?? new OpenClawApiRunner({
    endpoint: options.endpoint ?? assert.fail("API endpoint is required for the OpenClaw HTTP runner"),
    tokenFile,
    agentTarget: "openclaw/fixture",
  });
  const adapterOptions: HarnessAdapterOptions = {
    definition: openClawDefinition,
    runner,
    store,
    sessionNamespace: options.recipientAlias ?? "argos",
    fallbackSessionKey: "alias-default",
    ...(options.commandOverride === undefined ? {} : { commandOverride: options.commandOverride }),
  };
  return { ...deliveryHarnesses(adapterOptions, runner), store, tokenFile };
}

export function humanDelivery(options: {
  readonly id: string;
  readonly humanId?: string;
  readonly tenantId?: string;
  readonly conversationId?: string;
  readonly recipientAlias?: string;
  readonly bodyHumanId?: string;
  readonly loginSessionId?: string;
}): Delivery {
  const eventId = randomUUID();
  const messageId = randomUUID();
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: options.id,
    event_id: eventId,
    message_id: messageId,
    request_id: randomUUID(),
    trace_id: `trace-${options.id}`,
    epoch: 1,
    attempt: 1,
    claim_token: randomUUID(),
    ack_deadline_at: new Date(Date.now() + 120_000).toISOString(),
    tenant_id: options.tenantId ?? "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: options.recipientAlias ?? "argos",
    body: { prompt: `synthetic human message ${options.id}`, timeout_ms: 30_000,
      ...(options.bodyHumanId === undefined ? {} : { human_id: options.bodyHumanId }) },
    human_initiator: {
      human_id: options.humanId ?? "11111111-1111-4111-8111-111111111111",
      tenant_id: options.tenantId ?? "Steven",
      conversation_id: options.conversationId ?? "operator-chat-1",
      root_message_id: messageId,
    },
    authenticated_context: { session_id: options.loginSessionId ?? `login-${options.id}`, channel: "human-mcp" },
  };
}

export async function createDeliveryEngine(options: {
  readonly stateDirectory: string;
  readonly endpoint?: string;
  readonly runner?: CommandRunner;
  readonly store?: DurableStore;
  readonly ownTenantId?: string;
  readonly recipientAlias?: string;
  readonly commandOverride?: HarnessAdapterOptions["commandOverride"];
}) {
  const harnesses = await createOpenClawHarnesses(options);
  const events: DeliveryEvent[] = [];
  const engineRef: { current?: AdapterEngine } = {};
  const engine = new AdapterEngine({
    store: harnesses.store,
    harness: harnesses.harness,
    harnessForDelivery: humanHarnessSelector(harnesses.harness, harnesses.humanHarness),
    executionIntentMode: "local-test-only",
    publish: async (event) => {
      events.push(event);
      if (event.claim_renewal === true) {
        engineRef.current?.confirmClaim(event.delivery_id, event.attempt, event.claim_token);
      }
    },
    claimRenewalMs: 10_000,
    claimWatchdogMs: 60_000,
    ...(options.ownTenantId === undefined ? {} : { ownTenantId: options.ownTenantId }),
  });
  engineRef.current = engine;
  await engine.activateEpoch(1);
  return { ...harnesses, events, engine };
}

export async function runDeliveries(options: {
  readonly stateDirectory: string;
  readonly endpoint: string;
  readonly deliveries: readonly Delivery[];
  readonly store?: DurableStore;
  readonly ownTenantId?: string;
  readonly recipientAlias?: string;
}) {
  const context = await createDeliveryEngine(options);
  for (const delivery of options.deliveries) await context.engine.handleDelivery(delivery);
  return context;
}

export function legacyBodyDelivery(id: string, bodyHumanId: string): Delivery {
  const delivery = humanDelivery({ id, bodyHumanId });
  const { human_initiator: _humanInitiator, ...legacy } = delivery;
  void _humanInitiator;
  return legacy;
}

export async function freshOpenClawState(name: string): Promise<string> {
  const directory = join(testStateRoot("openclaw-human-sessions"), `${name}-${randomUUID()}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

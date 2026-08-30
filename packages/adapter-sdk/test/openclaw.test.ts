import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { openClawDefinition, HarnessAdapter } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError } from "../src/sdk/errors.js";
import { OpenClawApiRunner } from "../src/sdk/openclaw-api-runner.js";

const root = resolve(".test-state/openclaw-api");
const STRUCTURED = {
  reply: "openclaw success",
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

interface CapturedRequest {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function setupServer(): Promise<{
  endpoint: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await requestBody(request);
    requests.push({ authorization: request.headers.authorization, body });
    const text = JSON.stringify(body).includes("SCENARIO:slow");
    const serialized = JSON.stringify(body);
    if (serialized.includes("SCENARIO:http-429")) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":"rate limited before execution"}');
      return;
    }
    if (serialized.includes("SCENARIO:http-500")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"execution state unknown"}');
      return;
    }
    if (text) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(STRUCTURED) } }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    requests,
    close: async () => new Promise<void>((resolveClose) => server.close(() => { resolveClose(); })),
  };
}

async function tokenFile(value: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, "openclaw.token");
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("OpenClaw API is loopback-only and forbids URL credentials", () => {
  const options = { tokenFile: "/unused" };
  assert.throws(() => new OpenClawApiRunner({ ...options, endpoint: "https://example.com/v1/chat/completions" }), /loopback/u);
  assert.throws(() => new OpenClawApiRunner({ ...options, endpoint: "http://user:pass@127.0.0.1/v1/chat/completions" }), /forbidden/u);
  assert.throws(() => new OpenClawApiRunner({ ...options, endpoint: "http://127.0.0.1/other" }), /chat\/completions/u);
});

test("OpenClaw API returns structured output and reloads token with a durable session", async () => {
  const api = await setupServer();
  const token = await tokenFile("token-one");
  const directory = resolve(root, "state");
  const store = await DurableStore.open(directory);
  const first = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token }),
    store,
    sessionNamespace: "kant",
  });
  const output = await first.execute({
    prompt: "do work",
    context: {
      self_alias: "jarvis",
      sender_alias: "seneca",
      tenant_id: "Steven",
      room_id: "grp.steven",
      channel: "agent-output",
      agent_message: true,
      message_type: "agent.response",
      routing_targets: [
        { tenant_id: "Miguel", alias: "kratos", online: true },
        { tenant_id: "Steven", alias: "socrates", online: false },
      ],
    },
    sessionKey: "trusted-conversation",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    origin: { adapter: "telegram", channel: "telegram", conversation_id: "42", relay: [], metadata: {} },
  });
  assert.equal(output.reply, "openclaw success");
  await writeFile(token, "token-two\n", { mode: 0o600 });

  const reopened = await DurableStore.open(directory);
  const second = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token }),
    store: reopened,
    sessionNamespace: "kant",
  });
  await second.execute({
    prompt: "continue",
    sessionKey: "trusted-conversation",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(api.requests.map((entry) => entry.authorization), ["Bearer token-one", "Bearer token-two"]);
  assert.equal(api.requests[0]?.body.user, api.requests[1]?.body.user);
  assert.match(JSON.stringify(api.requests[0]?.body), /TRUSTED ORIGIN CONTEXT/u);
  assert.match(JSON.stringify(api.requests[0]?.body), /\\"routing_targets\\":\[\{\\"tenant_id\\":\\"Miguel\\"/u);
  assert.match(JSON.stringify(api.requests[0]?.body), /\\"@all\\" is a reserved durable target/u);
  assert.match(JSON.stringify(api.requests[0]?.body), /synthesize the returned result in a non-empty/u);
  await api.close();
});

test("OpenClaw API timeout and cancellation abort requests", async () => {
  const api = await setupServer();
  const token = await tokenFile("api-token");
  const store = await DurableStore.open(resolve(root, "timeouts"));
  const adapter = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token }),
    store,
  });
  await assert.rejects(adapter.execute({
    prompt: "SCENARIO:slow",
    timeoutMs: 30,
    signal: new AbortController().signal,
  }), (error: unknown) =>
    error instanceof AdapterError
    && error.code === "EXECUTION_TIMEOUT_AMBIGUOUS"
    && !error.retryable);

  const controller = new AbortController();
  const running = adapter.execute({ prompt: "SCENARIO:slow", timeoutMs: 1_000, signal: controller.signal });
  setTimeout(() => { controller.abort(); }, 30);
  await assert.rejects(running, (error: unknown) =>
    error instanceof AdapterError
    && error.code === "EXECUTION_CANCELLED_AMBIGUOUS"
    && !error.retryable);
  assert.equal(api.requests.length, 2, "both ambiguous aborts occurred after OpenClaw accepted the request");
  await api.close();
});

test("OpenClaw API does not POST when the signal is already aborted", async () => {
  const api = await setupServer();
  const token = await tokenFile("api-token");
  const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runner.run({
      command: "unused",
      args: [],
      harness: "openclaw",
      stdin: "must not be dispatched",
      timeoutMs: 1_000,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof AdapterError
      && error.code === "CANCELLED"
      && !error.retryable,
  );
  assert.equal(api.requests.length, 0);
  await api.close();
});

test("OpenClaw API retries only an explicit pre-execution rejection", async () => {
  const api = await setupServer();
  const token = await tokenFile("api-token");
  const adapter = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token }),
    store: await DurableStore.open(resolve(root, "http-classification")),
  });

  await assert.rejects(
    adapter.execute({
      prompt: "SCENARIO:http-429",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof AdapterError
      && error.code === "OPENCLAW_HTTP_PRE_EXECUTION"
      && error.retryable,
  );
  await assert.rejects(
    adapter.execute({
      prompt: "SCENARIO:http-500",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof AdapterError
      && error.code === "OPENCLAW_HTTP_AMBIGUOUS"
      && !error.retryable,
  );
  await api.close();
});

test("OpenClaw native sessions are isolated by stable alias namespace", async () => {
  const api = await setupServer();
  const token = await tokenFile("api-token");
  const store = await DurableStore.open(resolve(root, "alias-isolation"));
  const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token });
  for (const alias of ["kant", "argos"]) {
    const adapter = new HarnessAdapter({ definition: openClawDefinition, runner, store, sessionNamespace: alias });
    await adapter.execute({
      prompt: "work",
      sessionKey: "same-conversation",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
  }
  assert.notEqual(api.requests[0]?.body.user, api.requests[1]?.body.user);
  await api.close();
});

test("OpenClaw alias fallback remains stable without origin session context", async () => {
  const api = await setupServer();
  const token = await tokenFile("api-token");
  const store = await DurableStore.open(resolve(root, "alias-fallback"));
  const adapter = new HarnessAdapter({
    definition: openClawDefinition,
    runner: new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token }),
    store,
    sessionNamespace: "kant",
    fallbackSessionKey: "alias-default",
  });
  for (const prompt of ["first", "second"]) {
    await adapter.execute({ prompt, timeoutMs: 1_000, signal: new AbortController().signal });
  }
  assert.equal(api.requests[0]?.body.user, api.requests[1]?.body.user);
  assert.equal(typeof api.requests[0]?.body.user, "string");
  await api.close();
});

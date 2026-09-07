import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openClawDefinition, HarnessAdapter } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError } from "../src/sdk/errors.js";
import { OpenClawApiRunner } from "../src/sdk/openclaw-api-runner.js";
import type { CommandRunRequest } from "../src/sdk/types.js";
import { reloadMaterial } from "./native-profile-fixtures.js";
import { testStateRoot } from "./test-state.js";

const root = testStateRoot("openclaw-api");
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

async function setupServer(
  respond?: (response: ServerResponse) => void | Promise<void>,
): Promise<{
  endpoint: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await requestBody(request);
    requests.push({ authorization: request.headers.authorization, body });
    if (respond) {
      await respond(response);
      return;
    }
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
    if (serialized.includes("SCENARIO:slow")) await delay(250);
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
    },
  };
}

function apiRequest(overrides: Partial<CommandRunRequest> = {}): CommandRunRequest {
  return {
    command: "unused", args: [], harness: "openclaw", stdin: "work", timeoutMs: 2_000,
    signal: new AbortController().signal,
    ...overrides,
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

test("OpenClaw API does not replay a whole turn after a provider error", async () => {
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
      && error.code === "OPENCLAW_HTTP_AMBIGUOUS"
      && !error.retryable,
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

test('OpenClaw upstream 429 after a side effect remains ambiguous and is not replayed', async (t) => {
  let sideEffects = 0;
  const api = await setupServer((response) => {
    sideEffects += 1;
    response.writeHead(429, {'content-type': 'application/json'});
    response.end(JSON.stringify({error: {type: 'api_error', message: 'upstream provider timeout; private=DO_NOT_ECHO'}}));
  });
  t.after(api.close);
  const runner = new OpenClawApiRunner({endpoint: api.endpoint, tokenFile: await tokenFile('api-token')});
  await assert.rejects(runner.run(apiRequest()), (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'OPENCLAW_HTTP_AMBIGUOUS');
    assert.equal(error.retryable, false);
    assert.match(error.message, /HTTP 429; category=upstream_timeout/u);
    assert.doesNotMatch(error.message, /DO_NOT_ECHO/u);
    return true;
  });
  assert.equal(sideEffects, 1);
  assert.equal(api.requests.length, 1);
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

test("OpenClaw API accepts delayed headers and preserves split UTF-8 output at the byte limit", async (t) => {
  const stdout = `  ${JSON.stringify({ text: "Revisión clínica 🙂" })}\n`;
  const bytes = Buffer.from(stdout);
  const api = await setupServer(async (response) => {
    await delay(80);
    response.writeHead(200, { "content-type": "application/json" });
    const split = bytes.indexOf(Buffer.from("🙂")) + 2;
    response.write(bytes.subarray(0, split));
    await delay(30);
    response.end(bytes.subarray(split));
  });
  t.after(api.close);
  const runner = new OpenClawApiRunner({
    endpoint: api.endpoint, tokenFile: await tokenFile("api-token"), maxOutputBytes: bytes.byteLength,
  });
  const output = await runner.run(apiRequest({ stdin: "Revisá todo 🙂", sessionId: "isolated-session" }));
  assert.deepEqual(output, { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false });
  assert.deepEqual(api.requests, [{
    authorization: "Bearer api-token",
    body: {
      model: "openclaw/default", stream: false, user: "isolated-session",
      messages: [{ role: "user", content: "Revisá todo 🙂" }],
    },
  }]);
});

for (const phase of ["before headers", "during body"] as const) {
  for (const cause of ["timeout", "cancellation"] as const) {
    test(`OpenClaw API ${cause} ${phase} closes the socket and returns only the abort classification`, { timeout: 5_000 }, async (t) => {
      const events = new EventEmitter();
      const accepted = once(events, "accepted");
      const closed = once(events, "closed");
      const api = await setupServer((response) => {
        response.once("close", () => events.emit("closed"));
        if (phase === "during body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"partial":"must not escape"');
        }
        events.emit("accepted");
      });
      t.after(api.close);
      const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: await tokenFile("api-token") });
      const controller = new AbortController();
      const running = runner.run(apiRequest({
        timeoutMs: cause === "timeout" ? 200 : 2_000, signal: controller.signal,
      }));
      await accepted;
      if (phase === "during body") await delay(30);
      if (cause === "cancellation") controller.abort();
      assert.deepEqual(await running, {
        stdout: "", stderr: "", exitCode: null, signal: null,
        timedOut: cause === "timeout", cancelled: cause === "cancellation",
      });
      await closed;
      assert.equal(api.requests.length, 1);
    });
  }
}

test("OpenClaw API stops a chunked oversized body before the peer finishes it", { timeout: 5_000 }, async (t) => {
  const events = new EventEmitter();
  const closed = once(events, "closed");
  const api = await setupServer(async (response) => {
    response.once("close", () => events.emit("closed"));
    response.writeHead(200, { "content-type": "application/json" });
    response.write("é".repeat(8));
    await delay(20);
    if (!response.destroyed) response.write("🙂".repeat(3));
  });
  t.after(api.close);
  const runner = new OpenClawApiRunner({
    endpoint: api.endpoint, tokenFile: await tokenFile("api-token"), maxOutputBytes: 24,
  });
  await assert.rejects(runner.run(apiRequest()), (error: unknown) =>
    error instanceof AdapterError && error.code === "OPENCLAW_OUTPUT_LIMIT_AMBIGUOUS" && !error.retryable);
  await closed;
});

for (const phase of ["before headers", "during body"] as const) {
  test(`OpenClaw API classifies a socket closed ${phase} as ambiguous`, async (t) => {
    const api = await setupServer(async (response) => {
      if (phase === "during body") {
        response.writeHead(200, { "content-type": "application/json", "content-length": 100 });
        response.write('{"partial":');
        await delay(20);
      }
      response.destroy();
    });
    t.after(api.close);
    const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: await tokenFile("api-token") });
    await assert.rejects(runner.run(apiRequest()), (error: unknown) =>
      error instanceof AdapterError && error.code === "OPENCLAW_API_AMBIGUOUS" && !error.retryable);
  });
}

test("OpenClaw API preserves HTTP classifications and never follows redirects or exposes response bodies", async (t) => {
  const target = await setupServer();
  t.after(target.close);
  let status = 401;
  const api = await setupServer((response) => {
    response.writeHead(status, { location: target.endpoint, "content-type": "application/json" });
    response.end('{"error":"api-token must not escape"}');
  });
  t.after(api.close);
  const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: await tokenFile("api-token") });
  for (const [code, expected, retryable] of [
    [401, "OPENCLAW_HTTP", false], [403, "OPENCLAW_HTTP", false],
    [425, "OPENCLAW_HTTP_AMBIGUOUS", false], [429, "OPENCLAW_HTTP_AMBIGUOUS", false],
    [408, "OPENCLAW_HTTP_AMBIGUOUS", false], [500, "OPENCLAW_HTTP_AMBIGUOUS", false],
    [503, "OPENCLAW_HTTP_AMBIGUOUS", false],
    ...[301, 302, 303, 307, 308].map((redirect) => [redirect, "OPENCLAW_API_AMBIGUOUS", false] as const),
  ] as const) {
    status = code;
    await assert.rejects(runner.run(apiRequest()), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, expected);
      assert.equal(error.retryable, retryable);
      assert.doesNotMatch(error.message, /api-token|must not escape/u);
      return true;
    });
  }
  assert.equal(target.requests.length, 0, "no redirect target receives a request or token");
  assert.equal(api.requests.length, 12);
});

test("OpenClaw API rejects an unsafe token file before sending HTTP", async (t) => {
  const api = await setupServer();
  t.after(api.close);
  const token = await tokenFile("api-token");
  await chmod(token, 0o644);
  const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: token });
  await assert.rejects(runner.run(apiRequest()), /0600 permissions/u);
  assert.equal(api.requests.length, 0);
});

test("OpenClaw API rejects HTTP 101 and closes the upgraded socket without hanging past its budget", { timeout: 1_000 }, async (t) => {
  const sockets: NonNullable<ServerResponse["socket"]>[] = [];
  const api = await setupServer((response) => {
    assert.ok(response.socket);
    sockets.push(response.socket);
    response.writeHead(101, { connection: "Upgrade", upgrade: "websocket" });
    response.flushHeaders();
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await api.close();
  });
  const runner = new OpenClawApiRunner({ endpoint: api.endpoint, tokenFile: await tokenFile("api-token") });
  await assert.rejects(runner.run(apiRequest({ timeoutMs: 100 })), (error: unknown) =>
    error instanceof AdapterError && error.code === "OPENCLAW_API_AMBIGUOUS" && !error.retryable);
  assert.equal(api.requests.length, 1);
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.ok(socket);
  if (!socket.destroyed) await once(socket, "close");
});

test("OpenClaw HTTPS rejects an untrusted certificate before sending the bearer token", async (t) => {
  const material = reloadMaterial(resolve(root, "untrusted-tls"), true);
  let requests = 0;
  const server = createHttpsServer({
    cert: await readFile(material.CAUCE_TLS_CERT_FILE),
    key: await readFile(material.CAUCE_TLS_KEY_FILE),
  }, (_request, response) => {
    requests += 1;
    response.end("unexpected authentication");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runner = new OpenClawApiRunner({
    endpoint: `https://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    tokenFile: await tokenFile("api-token"),
  });
  await assert.rejects(runner.run(apiRequest()), (error: unknown) =>
    error instanceof AdapterError && error.code === "OPENCLAW_API_AMBIGUOUS" && !error.retryable);
  assert.equal(requests, 0);
});

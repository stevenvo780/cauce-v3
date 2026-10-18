import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

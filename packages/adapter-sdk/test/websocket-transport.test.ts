import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@cauce/protocol";
import { SecureFileError } from "../src/sdk/secure-files.js";
import { WebSocketConsumerConnector } from "../src/sdk/websocket-transport.js";
import type { AdapterLog, ClientFrame } from "../src/sdk/types.js";

const root = resolve(".test-state/websocket-auth");

async function credential(name: string, value: string, mode = 0o600): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, name);
  await writeFile(path, value, { mode });
  await chmod(path, mode);
  return path;
}

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("production enforces wss and rejects development identity headers", () => {
  assert.throws(() => new WebSocketConsumerConnector("ws://127.0.0.1:8080"), /require wss/u);
  assert.throws(
    () => new WebSocketConsumerConnector("ws://127.0.0.1:8080", { environment: "production" }),
    /require wss/u,
  );
  assert.throws(
    () => new WebSocketConsumerConnector("wss://gateway.example", {
      environment: "production",
      developmentIdentity: { tenant_id: "Steven", alias: "kant" },
    }),
    /forbidden in production/u,
  );
  assert.throws(
    () => new WebSocketConsumerConnector("wss://user:secret@gateway.example"),
    /forbidden/u,
  );
});

test("bearer token and development headers reload safely on reconnect", async () => {
  const tokenFile = await credential("gateway.token", "first-token\n");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const received: Array<{ authorization?: string; tenant?: string; alias?: string }> = [];
  server.on("connection", (_socket, request) => {
    received.push({
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      ...(request.headers["x-cauce-tenant"] === undefined ? {} : { tenant: String(request.headers["x-cauce-tenant"]) }),
      ...(request.headers["x-cauce-alias"] === undefined ? {} : { alias: String(request.headers["x-cauce-alias"]) }),
    });
  });
  const connector = new WebSocketConsumerConnector(`ws://127.0.0.1:${address.port}`, {
    environment: "test",
    bearerTokenFile: tokenFile,
    developmentIdentity: { tenant_id: "Steven", alias: "kant" },
  });
  const first = await connector.connect(new AbortController().signal);
  await first.close();
  await writeFile(tokenFile, "second-token\n", { mode: 0o600 });
  const second = await connector.connect(new AbortController().signal);
  await second.close();
  assert.deepEqual(received, [
    { authorization: "Bearer first-token", tenant: "Steven", alias: "kant" },
    { authorization: "Bearer second-token", tenant: "Steven", alias: "kant" },
  ]);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

test("credential errors enforce 0600 and never expose bearer contents", async () => {
  const secret = "redact-me-99";
  const tokenFile = await credential("bad-mode.token", secret, 0o640);
  const connector = new WebSocketConsumerConnector("ws://127.0.0.1:9", {
    environment: "test",
    bearerTokenFile: tokenFile,
  });
  await assert.rejects(connector.connect(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof SecureFileError);
    assert.match(error.message, /0600/u);
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });
  const missing = new WebSocketConsumerConnector("ws://127.0.0.1:9", {
    environment: "test",
    bearerTokenFile: resolve(root, "missing.token"),
  });
  await assert.rejects(missing.connect(new AbortController().signal), /could not be loaded/u);
});

/**
 * The argos failure mode: an ACK whose `error` detail overflows the 2000-character cap
 * is refused by the outbound schema, never reaches the socket, stays at the head of the
 * durable outbox and kills every following connection. The throw is what the client
 * already reacts to; before this test the operator got a reconnect loop and nothing else.
 */
test("an outbound frame the schema refuses is logged with the rejected field path", async () => {
  const claimToken = "20000000-0000-4000-8000-000000000003";
  const sensitive = "saldo-cuenta-77213 ";
  const frame = {
    type: "ack",
    version: PROTOCOL_VERSION,
    event_id: "30000000-0000-4000-8000-000000000001",
    delivery_id: "40000000-0000-4000-8000-000000000002",
    attempt: 3,
    claim_token: claimToken,
    status: "failed",
    instance_id: "argos-1",
    epoch: 7,
    retryable: false,
    error: sensitive.repeat(200),
  } satisfies ClientFrame;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const accepted = once(server, "connection");
  const entries: AdapterLog[] = [];
  const connector = new WebSocketConsumerConnector(`ws://127.0.0.1:${address.port}`, {
    environment: "test",
    alias: "argos",
    logger: (entry) => { entries.push(entry); },
  });
  const connection = await connector.connect(new AbortController().signal);
  const [serverSocket] = await accepted as [import("ws").WebSocket];
  const delivered: string[] = [];
  serverSocket.on("message", (data: Buffer) => { delivered.push(data.toString("utf8")); });

  // Behaviour is unchanged: the failure still propagates to the caller.
  await assert.rejects(connection.send(frame), (error: unknown) => {
    assert.ok(error instanceof Error);
    return true;
  });

  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.event, "outbound_frame_invalid");
  assert.equal(entry.error_code, "OUTBOUND_FRAME_SCHEMA");
  assert.equal(entry.frame_type, "ack");
  assert.equal(entry.alias, "argos");
  assert.equal(entry.delivery_id, "40000000-0000-4000-8000-000000000002");
  assert.equal(entry.attempt, 3);
  assert.deepEqual(entry.issues?.map((issue) => issue.path), ["error"]);
  assert.equal(entry.issues?.[0]?.code, "too_big");
  assert.match(String(entry.claim_token_fingerprint), /^sha256:[0-9a-f]{12}$/u);
  assert.ok(typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)));

  // Neither the message content nor the claim capability may reach the journal.
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, new RegExp(sensitive, "u"));
  assert.doesNotMatch(serialized, new RegExp(claimToken, "u"));
  assert.ok(serialized.length < 1_000);

  // The happy path still encodes and still logs nothing. Frames are ordered on the
  // socket, so once the heartbeat lands, the refused ACK provably never went out.
  const received = once(serverSocket, "message");
  await connection.send({ type: "heartbeat", instance_id: "argos-1", epoch: 7 });
  await received;
  assert.equal(entries.length, 1);
  assert.deepEqual(delivered.map((raw) => JSON.parse(raw).type), ["heartbeat"]);

  await connection.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

test("mTLS requires complete valid owner-only material and wss", async () => {
  const certFile = await credential("client.crt", "not-a-certificate");
  const keyFile = await credential("client.key", "not-a-key");
  const caFile = await credential("ca.crt", "not-a-ca");
  assert.throws(() => new WebSocketConsumerConnector("ws://127.0.0.1:8080", {
    environment: "test",
    mutualTls: { certFile, keyFile, caFile },
  }), /mTLS requires a wss/u);
  const connector = new WebSocketConsumerConnector("wss://127.0.0.1:9", {
    environment: "production",
    mutualTls: { certFile, keyFile, caFile },
  });
  await assert.rejects(
    connector.connect(new AbortController().signal),
    (error: unknown) => error instanceof SecureFileError && /material is invalid/u.test(error.message),
  );
  const missing = new WebSocketConsumerConnector("wss://127.0.0.1:9", {
    environment: "production",
    mutualTls: { certFile: resolve(root, "missing.crt"), keyFile, caFile },
  });
  await assert.rejects(missing.connect(new AbortController().signal), /could not be loaded/u);
});

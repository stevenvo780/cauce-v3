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
  assert.deepEqual(
    // `JSON.parse` devuelve `any`: sin la anotación esta línea rompe `lint:adapter`.
    delivered.map((raw) => (JSON.parse(raw) as { type: string }).type),
    ["heartbeat"],
  );

  await connection.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

/**
 * ============================================================================================
 * EL FRAME QUE MATABA LA COLA
 *
 * `ack_result` ganó `delegation_rejections` y `chain_gate` en el store, el gateway los esparcía
 * al frame sin gate, y el miembro del esquema seguía `.strict()`. Del lado del adaptador eso NO
 * era "descarto este frame": `parse()` tiraba, el catch llamaba `queue.fail(...)` y eso rechaza
 * al iterador y a todos los que esperan — se cae la cola ENTERA de la conexión y con ella todas
 * las entregas en vuelo.
 *
 * Estos tests miran el FRAME, que es el hueco por donde entró el defecto: los tests que había
 * verificaban el valor de retorno de `ackDelivery` en el store, y ese valor era correcto. Lo que
 * nadie validaba era el frame que salía al cable.
 * ============================================================================================
 */

const frameIds = {
  event: "51000000-0000-4000-8000-000000000001",
  delivery: "52000000-0000-4000-8000-000000000001",
  message: "53000000-0000-4000-8000-000000000001",
  request: "54000000-0000-4000-8000-000000000001",
  claim: "55000000-0000-4000-8000-000000000001",
} as const;

function ackResultFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ack_result",
    event_id: frameIds.event,
    delivery_id: frameIds.delivery,
    attempt: 1,
    claim_token: frameIds.claim,
    status: "done",
    applied: true,
    receipt: "applied",
    ...extra,
  };
}

function deliveryFrame(): Record<string, unknown> {
  return {
    type: "delivery",
    version: PROTOCOL_VERSION,
    event_id: frameIds.event,
    delivery_id: frameIds.delivery,
    message_id: frameIds.message,
    request_id: frameIds.request,
    trace_id: "trace-survives-the-bad-frame",
    epoch: 1,
    attempt: 1,
    claim_token: frameIds.claim,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: "zeus",
    body: { text: "la cola sigue viva" },
  };
}

/** Un servidor que dice exactamente los frames que le pidamos, en orden. */
async function frameServer(): Promise<{
  port: number;
  say: (frame: unknown) => Promise<void>;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const connected = once(server, "connection") as Promise<[import("ws").WebSocket]>;
  return {
    port: address.port,
    say: async (frame: unknown) => {
      const [socket] = await connected;
      const raw = typeof frame === "string" ? frame : JSON.stringify(frame);
      await new Promise<void>((resolveSend, rejectSend) => {
        socket.send(raw, (error) => {
          if (error == null) resolveSend();
          else rejectSend(error);
        });
      });
    },
    close: async () => { await new Promise<void>((done) => server.close(() => done())); },
  };
}

test("the delegation feedback fields are part of the ack_result frame contract", async () => {
  const server = await frameServer();
  const entries: AdapterLog[] = [];
  const connector = new WebSocketConsumerConnector(`ws://127.0.0.1:${server.port}`, {
    environment: "test",
    alias: "zeus",
    logger: (entry) => { entries.push(entry); },
  });
  const connection = await connector.connect(new AbortController().signal);
  const frames = connection.frames()[Symbol.asyncIterator]();

  await server.say(ackResultFrame({
    delegation_rejections: [{
      code: "fanout_exceeded",
      reason: "Abanico agotado: este turno ya delegó 3 veces.",
      guidance: "No reintentes.",
      output_index: 0,
      target: "kratos",
    }],
    chain_gate: { gate_id: "gate-1", question: "¿Sigo?" },
  }));

  const received = await frames.next();
  assert.equal(received.done, false);
  const frame = received.value as Record<string, unknown>;
  assert.equal(frame.type, "ack_result");
  // El adaptador que declara la capability RECIBE los campos, no una versión recortada.
  assert.deepEqual(frame.delegation_rejections, [{
    code: "fanout_exceeded",
    reason: "Abanico agotado: este turno ya delegó 3 veces.",
    guidance: "No reintentes.",
    output_index: 0,
    target: "kratos",
  }]);
  assert.deepEqual(frame.chain_gate, { gate_id: "gate-1", question: "¿Sigo?" });
  assert.deepEqual(entries, []);

  await connection.close();
  await server.close();
});

test("a frame outside the schema is dropped and the queue keeps serving the next one", async () => {
  const server = await frameServer();
  const entries: AdapterLog[] = [];
  const connector = new WebSocketConsumerConnector(`ws://127.0.0.1:${server.port}`, {
    environment: "test",
    alias: "zeus",
    logger: (entry) => { entries.push(entry); },
  });
  const connection = await connector.connect(new AbortController().signal);
  const frames = connection.frames()[Symbol.asyncIterator]();

  // Un gateway MÁS NUEVO que este adaptador: un campo que su esquema no conoce. Es la forma
  // exacta del defecto, y también la de cualquier campo que se agregue en el futuro.
  await server.say(ackResultFrame({ delegation_disciplina_v2: { cap: 3 } }));
  // Y las otras dos formas de frame ilegible que llegaban al mismo `queue.fail`.
  await server.say("{no-es-json");
  await server.say({ type: "ack_result", applied: "no-es-booleano" });

  // LA aserción: la cola sobrevivió a los tres y sigue entregando. Los frames del WebSocket
  // están ordenados, así que recibir éste prueba que los anteriores no la mataron.
  await server.say(deliveryFrame());
  const received = await frames.next();
  assert.equal(received.done, false);
  const survivor = received.value as Record<string, unknown>;
  assert.equal(survivor.type, "delivery");
  assert.equal(survivor.trace_id, "trace-survives-the-bad-frame");

  // El descarte es observable, nunca silencioso.
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.event), [
    "inbound_frame_invalid", "inbound_frame_invalid", "inbound_frame_invalid",
  ]);
  assert.deepEqual(entries.map((entry) => entry.error_code), [
    "INBOUND_FRAME_SCHEMA", "INBOUND_FRAME_DECODE", "INBOUND_FRAME_SCHEMA",
  ]);
  assert.deepEqual(entries.map((entry) => entry.reason), [
    "frame_dropped", "frame_dropped", "frame_dropped",
  ]);
  assert.equal(entries[0]?.frame_type, "ack_result");
  assert.equal(entries[0]?.alias, "zeus");
  assert.equal(entries[0]?.delivery_id, frameIds.delivery);
  // `unrecognized_keys` se reporta en la raíz, no en la clave: el path es `<root>` y el NOMBRE
  // del campo que sobra viaja en el mensaje. Es el dato que sirve para diagnosticar deriva de
  // protocolo ("qué campo nuevo nos rompió"), así que el test lo fija explícitamente.
  assert.equal(entries[0]?.issues?.length, 1);
  assert.equal(entries[0]?.issues?.[0]?.code, "unrecognized_keys");
  assert.deepEqual(entries[0]?.issues?.map((issue) => issue.path), ["<root>"]);
  assert.match(String(entries[0]?.issues?.[0]?.message), /delegation_disciplina_v2/u);
  // El JSON roto no tiene forma, y aun así no derriba nada ni inventa campos.
  assert.equal(entries[1]?.frame_type, "unknown");
  assert.deepEqual(entries[1]?.issues, []);

  await connection.close();
  await server.close();
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

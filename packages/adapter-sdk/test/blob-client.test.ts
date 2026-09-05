import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { BlobClient, BlobClientError } from "../src/sdk/blob-client.js";
import { testStateRoot } from "./test-state.js";

interface Stored { readonly bytes: Buffer; readonly name: string; readonly mediaType: string }

const stored = new Map<string, Stored>();
const requests: { method: string; url: string; headers: IncomingMessage["headers"] }[] = [];
let server: Server;
let baseUrl: string;

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serve(request: IncomingMessage, response: ServerResponse): void {
  requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
  if (request.headers.authorization !== "Bearer secreto-de-prueba") {
    response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (request.method === "PUT" && request.url === "/v3/blobs") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const digest = sha(bytes);
      stored.set(digest, {
        bytes, name: String(request.headers["x-cauce-blob-name"]),
        mediaType: String(request.headers["x-cauce-blob-media-type"] ?? "application/octet-stream"),
      });
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
        sha256: digest, bytes: bytes.length, media_type: stored.get(digest)?.mediaType, name: stored.get(digest)?.name,
        blob: `sha256:${digest}`, uri: `cauce-blob:sha256:${digest}`,
      }));
    });
    return;
  }
  const match = /^\/v3\/blobs\/([a-f0-9]{64})$/u.exec(request.url ?? "");
  const entry = match === null ? undefined : stored.get(match[1] ?? "");
  if (request.method !== "GET" || entry === undefined) {
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  response.writeHead(200, { "content-type": entry.mediaType, "content-length": String(entry.bytes.length) });
  // Two chunks so the client has to keep streaming instead of reading one buffer.
  response.write(entry.bytes.subarray(0, Math.floor(entry.bytes.length / 2)));
  response.end(entry.bytes.subarray(Math.floor(entry.bytes.length / 2)));
}

before(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  await mkdir(testStateRoot("blob-client"), { recursive: true });
  await writeFile(testStateRoot("blob-client", "token"), "secreto-de-prueba\n", { mode: 0o600 });
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
});

function client(): BlobClient {
  return BlobClient.fromRelayUrl(`${baseUrl.replace("http:", "ws:")}/v3/ws`, {
    bearerTokenFile: testStateRoot("blob-client", "token"),
  });
}

test("derives the HTTP origin from the relay url", () => {
  assert.equal(BlobClient.fromRelayUrl("wss://gateway:8443/v3/ws", {}).baseUrl, "https://gateway:8443");
  assert.equal(BlobClient.fromRelayUrl("ws://127.0.0.1:8080/v3/ws", {}).baseUrl, "http://127.0.0.1:8080");
});

test("uploads a file from disk with its name and type, and answers the digest the server saw", async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 5);
  const path = testStateRoot("blob-client", "subida.bin");
  await writeFile(path, bytes);
  const receipt = await client().upload(path, { name: "subida.bin", mediaType: "application/octet-stream" });
  assert.equal(receipt.sha256, sha(bytes));
  assert.equal(receipt.bytes, bytes.length);
  assert.equal(receipt.uri, `cauce-blob:sha256:${sha(bytes)}`);
  const put = requests.find((entry) => entry.method === "PUT");
  assert.equal(put?.headers["x-cauce-blob-name"], "subida.bin");
  assert.equal(put?.headers["content-type"], "application/octet-stream");
  assert.equal(put?.headers["content-length"], String(bytes.length));
  assert.equal(put?.headers["x-cauce-blob-sha256"], sha(bytes));
});

test("downloads a blob to a path and verifies the digest and size on the way", async () => {
  const bytes = Buffer.from("contenido del blob que baja", "utf8");
  const digest = sha(bytes);
  stored.set(digest, { bytes, name: "baja.txt", mediaType: "text/plain" });
  const destination = testStateRoot("blob-client", "baja.txt");
  const result = await client().download(digest, destination, { expectedBytes: bytes.length });
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.mediaType, "text/plain");
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(((await stat(destination)).mode & 0o777), 0o600);
});

test("refuses bytes whose digest is not the one requested and leaves no file behind", async () => {
  const bytes = Buffer.from("otro contenido", "utf8");
  const wrong = "f".repeat(64);
  stored.set(wrong, { bytes, name: "x", mediaType: "text/plain" });
  const destination = testStateRoot("blob-client", "wrong.txt");
  await assert.rejects(client().download(wrong, destination, {}), (error: unknown) =>
    error instanceof BlobClientError && error.code === "DIGEST_MISMATCH");
  await assert.rejects(stat(destination));
});

test("reports an unknown blob as NOT_FOUND and a rejected credential as UNAUTHORIZED", async () => {
  await assert.rejects(client().download("a".repeat(64), testStateRoot("blob-client", "nada"), {}), (error: unknown) =>
    error instanceof BlobClientError && error.code === "NOT_FOUND");
  const anonymous = BlobClient.fromRelayUrl(`${baseUrl.replace("http:", "ws:")}/v3/ws`, {});
  await assert.rejects(anonymous.download("a".repeat(64), testStateRoot("blob-client", "nada2"), {}), (error: unknown) =>
    error instanceof BlobClientError && error.code === "UNAUTHORIZED");
});

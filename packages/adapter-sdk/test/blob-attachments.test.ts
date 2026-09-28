import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { blobArtifactUri, blobLocator, MAX_ATTACHMENTS_PER_MESSAGE } from "@cauce/protocol";
import { materializeAttachments } from "../src/sdk/attachments.js";
import { BlobClientError, configureDefaultBlobClient, type BlobFetcher } from "../src/sdk/blob-client.js";

const PAYLOAD = Buffer.from("bytes que viven en el almacén de blobs, no en el mensaje", "utf8");
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function fetcher(bytes: Buffer = PAYLOAD): BlobFetcher & { calls: { sha256: string; destination: string; expectedBytes?: number }[] } {
  const calls: { sha256: string; destination: string; expectedBytes?: number }[] = [];
  return {
    calls,
    async download(sha256, destination, options) {
      calls.push({ sha256, destination, ...(options.expectedBytes === undefined ? {} : { expectedBytes: options.expectedBytes }) });
      if (sha256 !== SHA) throw new BlobClientError("NOT_FOUND", "unknown");
      await writeFile(destination, bytes, { mode: 0o600 });
      return { sha256, bytes: bytes.length, mediaType: "text/plain" };
    },
  };
}

function blobEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "document", name: "grande.txt", mime_type: "text/plain", file_size: PAYLOAD.length, blob: blobLocator(SHA), ...overrides };
}

function inlineEntry(name: string): Record<string, unknown> {
  const payload = Buffer.from(name, "utf8");
  return {
    kind: "document", name, mime_type: "text/plain", file_size: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"), content_base64: payload.toString("base64"),
  };
}

test("un adjunto por referencia se descarga al directorio del turno con su digest y tamaño verificados", async () => {
  const blobs = fetcher();
  const result = await materializeAttachments({ attachments_v1: [blobEntry()] }, blobs);
  assert.ok(result);
  const materialized = result.attachments[0];
  assert.ok(materialized);
  assert.equal(materialized.name, "grande.txt");
  assert.equal(materialized.sha256, SHA);
  assert.equal(materialized.size, PAYLOAD.length);
  assert.equal(materialized.kind, "document");
  assert.ok((await readFile(materialized.path)).equals(PAYLOAD));
  assert.ok(materialized.path.startsWith(result.directory));
  assert.deepEqual(blobs.calls, [{ sha256: SHA, destination: materialized.path, expectedBytes: PAYLOAD.length }]);
  assert.match(result.prompt, /grande\.txt/u);
  assert.match(result.prompt, /"local_path":"[^"]+"/u);
  await result.cleanup();
});

test("una referencia de artefacto de otro agente (artifacts_v1 con uri cauce-blob) también se materializa", async () => {
  const blobs = fetcher();
  const result = await materializeAttachments({
    artifacts_v1: [{ name: "informe.txt", uri: blobArtifactUri(SHA), media_type: "text/plain", size: PAYLOAD.length }],
  }, blobs);
  assert.ok(result);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.sha256, SHA);
  assert.ok((await readFile(result.attachments[0]?.path ?? "")).equals(PAYLOAD));
  await result.cleanup();
});

test("los bytes inline y las referencias comparten el mismo tope de adjuntos por mensaje", async () => {
  const inline = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => inlineEntry(`n${String(index)}.txt`));
  await assert.rejects(
    materializeAttachments({ attachments_v1: inline, artifacts_v1: [{ name: "x.txt", uri: blobArtifactUri(SHA) }] }, fetcher()),
    { code: "INVALID_ATTACHMENT" },
  );
});

test("sin cliente de blobs configurado, una referencia es un adjunto que no se puede materializar", async () => {
  configureDefaultBlobClient(undefined);
  await assert.rejects(materializeAttachments({ attachments_v1: [blobEntry()] }), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === "INVALID_ATTACHMENT" && /blob/u.test(error.message));
});

test("un blob que el almacén no tiene, o cuyos bytes no cuadran, no cuesta silencio: falla el adjunto con su causa", async () => {
  const missing = blobEntry({ blob: blobLocator("e".repeat(64)) });
  await assert.rejects(materializeAttachments({ attachments_v1: [missing] }, fetcher()), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === "INVALID_ATTACHMENT" && /unknown/u.test(error.message));
  const liar: BlobFetcher = {
    async download() { throw new BlobClientError("DIGEST_MISMATCH", "blob bytes do not match their digest"); },
  };
  await assert.rejects(materializeAttachments({ attachments_v1: [blobEntry()] }, liar), (error: unknown) =>
    error instanceof Error && /digest/u.test(error.message));
});

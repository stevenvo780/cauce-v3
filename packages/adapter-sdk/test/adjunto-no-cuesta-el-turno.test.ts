import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";
import { MAX_ATTACHMENT_BYTES } from "@cauce/protocol";
import { materializeAttachments } from "../src/sdk/attachments.js";

function attachment(name: string, payload: Buffer): Record<string, unknown> {
  return {
    kind: "document",
    name,
    mime_type: "application/octet-stream",
    file_size: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    content_base64: payload.toString("base64"),
  };
}

/**
 * The protocol admits 10 MB per attachment, so the adapter has to materialize exactly that: a
 * validator that gives up before the cap turns an accepted delivery into a lost turn.
 */
test("un adjunto del tamaño máximo del protocolo se materializa entero", async () => {
  const payload = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7);
  const result = await materializeAttachments({ attachments_v1: [attachment("grande.bin", payload)] });
  assert.ok(result);
  const materialized = result.attachments[0];
  assert.ok(materialized);
  assert.ok((await readFile(materialized.path)).equals(payload));
  await result.cleanup();
  await assert.rejects(access(materialized.path), { code: "ENOENT" });
});

/**
 * Every validator on the name counts characters and the filesystem counts bytes. A name the
 * schema accepts must still reach the disk: the file keeps its declared name for the agent and
 * a shortened one on disk, never a failed turn.
 */
test("un nombre válido para el esquema pero más largo que NAME_MAX llega igual", async () => {
  const payload = Buffer.from("contenido", "utf8");
  for (const name of [`${"a".repeat(251)}.txt`, `${"🚀".repeat(64)}.txt`, "b".repeat(255)]) {
    const result = await materializeAttachments({ attachments_v1: [attachment(name, payload)] });
    assert.ok(result, name);
    const materialized = result.attachments[0];
    assert.ok(materialized);
    assert.equal(materialized.name, name);
    const onDisk = basename(materialized.path);
    assert.ok(Buffer.byteLength(onDisk, "utf8") <= 255, onDisk);
    assert.ok(onDisk.startsWith("1-"));
    if (name.endsWith(".txt")) assert.ok(onDisk.endsWith(".txt"), onDisk);
    assert.ok((await readFile(materialized.path)).equals(payload));
    assert.match(result.prompt, /"local_path":"[^"]+"/u);
    await result.cleanup();
  }
});

test("el base64 corrupto o no canónico sigue siendo un adjunto inválido", async () => {
  const base = attachment("hola.txt", Buffer.from("hola", "utf8"));
  for (const content_base64 of ["aG9sYQ", "aG9sYQ=!", "aG9sYQ===", "aG9sYR=="]) {
    await assert.rejects(
      materializeAttachments({ attachments_v1: [{ ...base, content_base64 }] }),
      { code: "INVALID_ATTACHMENT" },
      content_base64,
    );
  }
});

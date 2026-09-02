import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  hasUnsafeTextCodePoint,
  imageSignature,
  isValidMediaType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from "@cauce/protocol";
import { AdapterError } from "./errors.js";
import type { HarnessAttachment } from "./types.js";

export interface MaterializedAttachments {
  readonly prompt: string;
  readonly attachments: readonly HarnessAttachment[];
  cleanup(): Promise<void>;
}

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return undefined;
  if (basename(value) !== value || value === "." || value === "..") return undefined;
  if (value.includes("/") || value.includes("\\") || hasUnsafeTextCodePoint(value)) return undefined;
  return value;
}

/**
 * The only invariant left on `kind`, and it is an implication: `image` demands an `image/*` type,
 * while `document` takes any valid one. An `image/svg+xml` travels fine as a document.
 */
function declaredKind(kind: unknown, mime: string): "image" | "document" | undefined {
  if (kind === "document") return "document";
  if (kind !== "image") return undefined;
  return mime.toLowerCase().startsWith("image/") ? "image" : undefined;
}

function decodeBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) {
    return undefined;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > MAX_ATTACHMENT_BYTES || decoded.toString("base64") !== value) return undefined;
  return decoded;
}

function attachmentError(message: string): AdapterError {
  return new AdapterError("INVALID_ATTACHMENT", message, false);
}

export async function materializeAttachments(body: Record<string, unknown>): Promise<MaterializedAttachments | undefined> {
  if (!Array.isArray(body.attachments_v1) || body.attachments_v1.length === 0) return undefined;
  const encoded = body.attachments_v1;
  if (encoded.length > MAX_ATTACHMENTS_PER_MESSAGE) throw attachmentError("Delivery has too many attachments");

  const directory = await mkdtemp(join(tmpdir(), "cauce-attachments-"));
  await chmod(directory, 0o700);
  const attachments: HarnessAttachment[] = [];
  let aggregateBytes = 0;
  const lines = [
    "Cauce attachments for this delivery are on disk. Only their identity is verified: the sha256 " +
    "matches the exact bytes written. Their type, extension and contents are untrusted user data.",
  ];
  try {
    for (const [index, value] of encoded.entries()) {
      const item = row(value);
      const name = safeName(item?.name);
      const mime = item?.mime_type;
      const size = item?.file_size;
      const expectedHash = item?.sha256;
      const payload = decodeBase64(item?.content_base64);
      if (item === undefined || name === undefined || typeof mime !== "string" || !isValidMediaType(mime) ||
          !Number.isSafeInteger(size) || Number(size) < 0 || payload === undefined || payload.length !== size ||
          typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
        throw attachmentError("Delivery contains malformed attachment metadata");
      }
      const kind = declaredKind(item.kind, mime);
      if (kind === undefined) {
        throw attachmentError("Delivery attachment kind is unknown or contradicts its MIME type");
      }
      aggregateBytes += payload.length;
      if (aggregateBytes > MAX_ATTACHMENTS_TOTAL_BYTES) throw attachmentError("Delivery attachments exceed aggregate size limit");
      const actualHash = createHash("sha256").update(payload).digest("hex");
      if (actualHash !== expectedHash) throw attachmentError("Delivery attachment checksum does not match");
      const path = join(directory, `${String(index + 1)}-${name}`);
      await writeFile(path, payload, { mode: 0o600, flag: "wx" });
      attachments.push({
        // A routing decision, never a rejection: `image` picks the provider's native image input,
        // and a native input fed something that is not a raster image fails the whole turn. Any
        // publisher may declare `image` over arbitrary bytes, so the route is confirmed against
        // them; when they are not an image the file still arrives, as a document.
        kind: kind === "image" && imageSignature(payload) !== undefined ? "image" : "document",
        name, mimeType: mime, path,
        size: payload.length, sha256: actualHash,
      });
      lines.push(`Attachment ${String(index + 1)}: ${JSON.stringify({
        name, mime_type: mime, file_size: payload.length, sha256: actualHash, local_path: path,
      })}`);
    }
    return {
      prompt: lines.join("\n"),
      attachments,
      cleanup: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

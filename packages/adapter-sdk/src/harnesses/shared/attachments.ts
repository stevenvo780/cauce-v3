import type { HarnessAttachment, HarnessId } from "../../sdk/types.js";

/**
 * Media types a provider's native image input can actually decode.
 *
 * `image/*` is wider than this: `image/svg+xml` is markup and `image/heic` is not decodable.
 * Feeding either to the native argument fails the whole turn, and an attachment must never cost a
 * turn, so anything outside this set takes the file path route.
 */
const NATIVE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

export function planAttachments(
  harness: HarnessId,
  attachments: readonly HarnessAttachment[],
): { args: readonly string[]; prompt: string } {
  const args: string[] = [];
  const lines: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const native = harness === "codex" && attachment.kind === "image" &&
      NATIVE_IMAGE_MEDIA_TYPES.has(attachment.mimeType.toLowerCase());
    if (native) {
      args.push("--image", attachment.path);
      lines.push(`attachment_${String(index + 1)} delivery_mode=native metadata=${JSON.stringify({
        name: attachment.name, mime_type: attachment.mimeType, size: attachment.size,
        sha256: attachment.sha256,
      })}`);
    } else {
      lines.push(`attachment_${String(index + 1)} delivery_mode=filesystem_fallback; provider does not expose native ${attachment.mimeType} input; inspect this verified local file with available file/vision tools: ${JSON.stringify({
        name: attachment.name, path: attachment.path, size: attachment.size, sha256: attachment.sha256,
      })}`);
    }
  }
  return { args, prompt: lines.join("\n") };
}

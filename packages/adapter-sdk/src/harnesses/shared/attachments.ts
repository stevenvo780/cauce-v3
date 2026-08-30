import type { HarnessAttachment, HarnessId } from "../../sdk/types.js";

export function planAttachments(
  harness: HarnessId,
  attachments: readonly HarnessAttachment[],
): { args: readonly string[]; prompt: string } {
  const args: string[] = [];
  const lines: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const native = harness === "codex" && attachment.kind === "image";
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

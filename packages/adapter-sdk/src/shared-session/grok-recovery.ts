import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  grokSessionIdOf,
  grokSessionIsSecure,
  grokWorkspaceSessionFilesStrict,
  isGrokSessionId,
} from "./grok.js";

type WorkspaceRecovery =
  | { readonly state: "candidate"; readonly nativeId: string }
  | { readonly state: "absent" | "ambiguous" | "unreadable" };

const MAX_SUMMARY_BYTES = 256 * 1024;
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function summaryState(file: string, workspace: string, nativeId: string): Promise<"conversation" | "subagent" | "invalid"> {
  let handle;
  try {
    handle = await open(join(dirname(file), "summary.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK | O_CLOEXEC);
    const before = await handle.stat({ bigint: true });
    const euid = process.geteuid?.();
    if (euid === undefined || !before.isFile() || before.uid !== BigInt(euid) || before.nlink !== 1n
      || (before.mode & 0o022n) !== 0n || before.size <= 0n || before.size > BigInt(MAX_SUMMARY_BYTES)) return "invalid";
    const buffer = Buffer.alloc(MAX_SUMMARY_BYTES + 1);
    let length = 0;
    while (length <= MAX_SUMMARY_BYTES) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length > MAX_SUMMARY_BYTES || BigInt(length) !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) return "invalid";
    const summary = asObject(JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown);
    if (summary === undefined) return "invalid";
    const kind = summary.session_kind;
    if (kind !== undefined && typeof kind !== "string") return "invalid";
    if (typeof kind === "string" && (kind === "subagent" || kind.startsWith("subagent_"))) return "subagent";
    const info = asObject(summary.info);
    return info?.id === nativeId && typeof info.cwd === "string" && isAbsolute(info.cwd)
      && await realpath(info.cwd) === workspace ? "conversation" : "invalid";
  } catch {
    return "invalid";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function grokWorkspaceConversationIsSecure(grokHome: string, nativeId: string, workspace: string): Promise<boolean> {
  const approvedWorkspace = await realpath(workspace);
  const transcript = join(grokHome, "sessions", encodeURIComponent(approvedWorkspace), nativeId, "updates.jsonl");
  return await grokSessionIsSecure(grokHome, nativeId, approvedWorkspace)
    && await summaryState(transcript, approvedWorkspace, nativeId) === "conversation";
}

/** Only UUIDv7's timestamp supplies a creation order; filesystem mtimes do not. */
export async function recoverGrokWorkspaceConversation(grokHome: string, workspace: string): Promise<WorkspaceRecovery> {
  try {
    const approvedWorkspace = await realpath(workspace);
    const candidates: string[] = [];
    for (const file of await grokWorkspaceSessionFilesStrict(grokHome, approvedWorkspace)) {
      try {
        const metadata = await lstat(file);
        if (!metadata.isFile()) return { state: "unreadable" };
        if (metadata.size === 0) continue;
        const nativeId = grokSessionIdOf(file);
        if (!isGrokSessionId(nativeId)) return { state: "ambiguous" };
        const summary = await summaryState(file, approvedWorkspace, nativeId);
        if (summary === "subagent") continue;
        if (summary !== "conversation") return { state: "unreadable" };
        candidates.push(nativeId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { state: "unreadable" };
      }
    }
    if (candidates.length === 0) return { state: "absent" };
    if (candidates.length > 1 && candidates.some((id) => id[14] !== "7")) return { state: "ambiguous" };
    candidates.sort().reverse();
    const nativeId = candidates[0];
    if (nativeId === undefined) return { state: "absent" };
    if (candidates.length > 1 && nativeId.slice(0, 13) === candidates[1]?.slice(0, 13)) {
      return { state: "ambiguous" };
    }
    return await grokWorkspaceConversationIsSecure(grokHome, nativeId, approvedWorkspace)
      ? { state: "candidate", nativeId }
      : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

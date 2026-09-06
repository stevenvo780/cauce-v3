import { randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { rolloutDirectory } from "./rollout.js";
import { SharedTuiPointerStore } from "./native-pointer.js";
import { transcriptDirectoryIn } from "./session.js";
import type {
  ResumeLaunchPlan,
  ResumeSpec,
  SharedSessionHarness,
} from "./types.js";

/**
 * Detection and configuration of previous conversation session resumption in the TUI.
 */

/** Cap on rollouts to inspect when checking for resumable conversations. */
const MAX_ROLLOUTS_INSPECTED = 200;

/** Cap on bytes to read when extracting the `session_meta` header from a rollout. */
const HEADER_READ_LIMIT_BYTES = 256 * 1024;

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

export interface SharedSessionResumeBinding {
  readonly alias: string;
  readonly stateDirectory: string;
}

export function sharedSessionResume(
  harness: SharedSessionHarness,
  configDirectory: string,
  workspace: string,
  binding?: SharedSessionResumeBinding,
): ResumeSpec {
  return harness === "codex"
    ? {
      args: ["resume", "--last"],
      hasPreviousConversation: () => codexHasPreviousConversation(configDirectory, workspace),
    }
    : {
      resolveLaunch: () => resolveClaudeLaunch(
        configDirectory,
        workspace,
        binding,
      ),
    };
}

export async function resolveClaudeLaunch(
  configDirectory: string,
  workspace: string,
  binding: SharedSessionResumeBinding | undefined,
): Promise<ResumeLaunchPlan> {
  if (binding === undefined) {
    return { state: "blocked", detail: "Claude exact resume requires alias state" };
  }
  try {
    const store = new SharedTuiPointerStore(binding.stateDirectory);
    const pointer = await store.read({
      alias: binding.alias,
      harness: "claude",
      configDirectory,
      workspace,
    });
    if (pointer.state === "invalid") {
      return { state: "blocked", detail: "Claude shared TUI pointer is invalid" };
    }
    if (pointer.state === "valid") {
      if (!CLAUDE_SESSION_ID.test(pointer.nativeId)) {
        return { state: "blocked", detail: "Claude shared TUI pointer is not a canonical UUID" };
      }
      if (!await exactClaudeTranscriptIsSecure(pointer.binding, pointer.nativeId)) {
        return { state: "blocked", detail: "Claude exact transcript could not be accredited" };
      }
      return { state: "launch", args: ["--resume", pointer.nativeId], resumed: true };
    }

    const history = await claudeConversationHistoryState(configDirectory, workspace);
    if (history === "present") {
      return {
        state: "blocked",
        detail: "Claude legacy history exists without an exact shared TUI pointer",
      };
    }
    if (history === "unreadable") {
      return { state: "blocked", detail: "Claude legacy history could not be inspected" };
    }
    return { state: "launch", args: ["--session-id", randomUUID()], resumed: false };
  } catch {
    return { state: "blocked", detail: "Claude exact resume state could not be inspected" };
  }
}

async function exactClaudeTranscriptIsSecure(
  binding: { readonly configDirectory: string; readonly workspace: string },
  nativeId: string,
): Promise<boolean> {
  const directory = transcriptDirectoryIn(binding.configDirectory, binding.workspace);
  let directoryHandle;
  let transcriptHandle;
  try {
    if (await realpath(directory) !== normalize(directory)) return false;
    directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
    );
    const directoryMetadata = await directoryHandle.stat({ bigint: true });
    const euid = process.geteuid?.();
    if (euid === undefined
      || !directoryMetadata.isDirectory()
      || directoryMetadata.uid !== BigInt(euid)
      || (directoryMetadata.mode & 0o022n) !== 0n) return false;
    transcriptHandle = await open(
      join(directory, `${nativeId}.jsonl`),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
    );
    const metadata = await transcriptHandle.stat({ bigint: true });
    return metadata.isFile()
      && metadata.uid === BigInt(euid)
      && metadata.nlink === 1n
      && (metadata.mode & 0o022n) === 0n
      && metadata.size > 0n;
  } catch {
    return false;
  } finally {
    await transcriptHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

/** Checks whether Codex has a previous interactive session that is resumable for the given workspace. */
export async function codexHasPreviousConversation(
  codexHome: string,
  workspace: string,
): Promise<boolean> {
  const files = await rolloutsByRecency(rolloutDirectory(codexHome));
  for (const file of files.slice(0, MAX_ROLLOUTS_INSPECTED)) {
    const meta = await rolloutHeader(file);
    if (meta === undefined) continue;
    if (meta.source !== "cli") continue;
    if (meta.cwd !== workspace) continue;
    return true;
  }
  return false;
}

/** Checks whether Claude has a previous conversation in the workspace transcripts directory. */
export async function claudeHasPreviousConversation(
  configDirectory: string,
  workspace: string,
): Promise<boolean> {
  return await claudeConversationHistoryState(configDirectory, workspace) === "present";
}

export async function claudeConversationHistoryState(
  configDirectory: string,
  workspace: string,
): Promise<"absent" | "present" | "unreadable"> {
  const directory = transcriptDirectoryIn(configDirectory, workspace);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const info = await stat(join(directory, name));
      if (info.isFile() && info.size > 0) return "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
    }
  }
  return "absent";
}

/** The tree's rollouts, newest to oldest by their name (which is chronological). */
async function rolloutsByRecency(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** The rollout's `session_meta`: only the first line, and with a read cap. */
async function rolloutHeader(
  file: string,
): Promise<{ source?: unknown; cwd?: unknown } | undefined> {
  let line: string | undefined;
  try {
    const stream = createReadStream(file, {
      start: 0, end: HEADER_READ_LIMIT_BYTES - 1, encoding: "utf8",
    });
    let raw = "";
    for await (const chunk of stream) {
      raw += String(chunk);
      const cut = raw.indexOf("\n");
      if (cut >= 0) {
        stream.destroy();
        line = raw.slice(0, cut);
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const payload = (value as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return payload;
}

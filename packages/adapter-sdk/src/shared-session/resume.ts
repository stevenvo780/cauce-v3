import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { rolloutDirectory } from "./rollout.js";
import { transcriptDirectoryIn } from "./session.js";
import type { ResumeSpec, SharedSessionHarness } from "./types.js";

/**
 * Detection and configuration of previous conversation session resumption in the TUI.
 */

/** Cap on rollouts to inspect when checking for resumable conversations. */
const MAX_ROLLOUTS_INSPECTED = 200;

/** Cap on bytes to read when extracting the `session_meta` header from a rollout. */
const HEADER_READ_LIMIT_BYTES = 256 * 1024;

export function sharedSessionResume(
  harness: SharedSessionHarness,
  configDirectory: string,
  workspace: string,
): ResumeSpec {
  return harness === "codex"
    ? {
      args: ["resume", "--last"],
      hasPreviousConversation: () => codexHasPreviousConversation(configDirectory, workspace),
    }
    : {
      args: ["--continue"],
      hasPreviousConversation: () => claudeHasPreviousConversation(configDirectory, workspace),
    };
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
  const directory = transcriptDirectoryIn(configDirectory, workspace);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const info = await stat(join(directory, name));
      if (info.isFile() && info.size > 0) return true;
    } catch {
      // A file that disappears between listing and `stat` is not a resumable conversation.
    }
  }
  return false;
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

import { lstat } from "node:fs/promises";
import { CODEX_WAKE_PREFIX } from "./codex-chain.js";
import { CORRELATION_BLOCK_START } from "./envelope.js";
import type { TranscriptReader } from "./types.js";

/** Who wrote the last prompt of the TUI's conversation: its human, or Cauce pasting a delivery or a wake. */
export type PromptOrigin = "human" | "cauce";

/**
 * Attribution of one prompt. Every bus prompt carries the correlation block and every codex wake
 * its prefix; a prompt that opens with a tag (task notification, command wrapper, reminder) was
 * written by the harness, not typed, so it is left unattributed and the caller must refuse.
 */
export function promptOrigin(text: string | undefined): PromptOrigin | undefined {
  if (text === undefined) return undefined;
  if (text.includes(CORRELATION_BLOCK_START) || text.trimStart().startsWith(CODEX_WAKE_PREFIX)) return "cauce";
  return text.trimStart().startsWith("<") ? undefined : "human";
}

async function modifiedAt(file: string): Promise<number> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/** The last prompt of the most recently written conversation; anything unreadable is undefined. */
export async function lastPromptOrigin<E>(reader: TranscriptReader<E>): Promise<PromptOrigin | undefined> {
  if (reader.lastUserPrompt === undefined) return undefined;
  try {
    const dated = await Promise.all((await reader.files()).map(async (file) => ({ file, at: await modifiedAt(file) })));
    dated.sort((left, right) => right.at - left.at);
    for (const { file, at } of dated) {
      if (at < 0) continue;
      if (reader.isConversation !== undefined && !(await reader.isConversation(file))) continue;
      return promptOrigin(reader.lastUserPrompt((await reader.read(file, 0)).entries));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

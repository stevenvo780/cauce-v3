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
  const typed = text.replace(HARNESS_REMINDER, "").trim().replace(USER_QUERY, "$1").trim(); // What remains is what was typed.
  if (typed.length === 0) return GOAL_REMINDER.test(text) ? "human" : undefined;
  return typed.startsWith("<") ? undefined : "human";
}

const HARNESS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu; // Added by the harness around the typed text.
const USER_QUERY = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/u;
const GOAL_REMINDER = /<system-reminder>\s*A goal has been set:/u; // grok /goal loop: work its owner launched, not bus content.

async function modifiedAt(file: string): Promise<number> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/** The last prompt of the most recently written conversation; anything unreadable is undefined. */
export async function lastPromptOrigin<E>(reader: TranscriptReader<E>, own?: (file: string) => boolean): Promise<PromptOrigin | undefined> {
  if (reader.lastUserPrompt === undefined) return undefined;
  try {
    const files = (await reader.files()).filter((file) => own === undefined || own(file));
    const dated = await Promise.all(files.map(async (file) => ({ file, at: await modifiedAt(file) })));
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

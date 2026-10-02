import { open, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether grok handed a pasted prompt to the model. Its log (`logs/unified.jsonl`) records
 * `prompt.enqueue {len}` when Enter queues the text and `prompt.drain {prompt_len}` when the turn
 * takes it; hades kept prompts enqueued and never drained while the adapter waited with no deadline.
 * Matched by the TUI's pid and the exact byte length grok reports (UTF-8 bytes of what was pasted).
 */
export interface DispatchMark {
  readonly file: string;
  offset: number; // Advances as the log is read: each poll scans only what grok wrote since.
  readonly pid: number;
  readonly bytes: number;
  state: DispatchState;
}

export type DispatchState = "drained" | "queued" | "unseen";

/** Enough for minutes of a busy pager; a log that grew more than this is read from its tail. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

export function grokPromptLog(grokHome: string): string {
  return join(grokHome.replace(/\/+$/u, ""), "logs", "unified.jsonl");
}

/** Where the log ends before Enter: what grok writes after it belongs to this paste. */
export async function grokDispatchMark(grokHome: string, pid: number, bytes: number): Promise<DispatchMark | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const file = grokPromptLog(grokHome);
  try {
    return { file, offset: (await stat(file)).size, pid, bytes, state: "unseen" };
  } catch {
    return undefined; // No log: the postcondition cannot be measured, so the old wait applies.
  }
}

export async function grokDispatchState(mark: DispatchMark): Promise<DispatchState> {
  let text: string;
  try {
    const handle = await open(mark.file, "r");
    try {
      const size = (await handle.stat()).size;
      if (size <= mark.offset) return mark.state; // Nothing new (or rotated: the old wait applies).
      const start = Math.max(mark.offset, size - MAX_READ_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const complete = buffer.lastIndexOf(0x0a) + 1; // Only whole lines; a half-written one is read next time.
      text = buffer.subarray(0, complete).toString("utf8");
      mark.offset = start + complete;
    } finally {
      await handle.close();
    }
  } catch {
    return mark.state;
  }
  let state = mark.state;
  for (const line of text.split("\n")) {
    let event: { pid?: unknown; msg?: unknown; ctx?: { len?: unknown; prompt_len?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue; // A partial first line or one being written.
    }
    if (event.pid !== mark.pid) continue;
    if (event.msg === "prompt.enqueue" && event.ctx?.len === mark.bytes) state = state === "drained" ? state : "queued";
    if (event.msg === "prompt.drain" && event.ctx?.prompt_len === mark.bytes) state = "drained";
  }
  mark.state = state;
  return state;
}

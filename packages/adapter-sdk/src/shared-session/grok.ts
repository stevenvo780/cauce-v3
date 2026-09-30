import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { envelopeHasCorrelation, stripJsonFence } from "./envelope.js";
import { readJsonlSince } from "./rollout.js";
import type { CompactionNotice, InjectedTurn, TranscriptReader, TurnOutcome } from "./types.js";

/**
 * Reader and analyzer for the session log of the grok TUI (Grok CLI 1.0.41).
 *
 * grok keeps one folder per conversation: `$GROK_HOME/sessions/<cwd url-encoded>/<session id>/`.
 * Of everything in there, `updates.jsonl` is the log grok itself resumes from (ACP
 * `session/update` stream), is written line by line while the turn runs, stores the user prompt
 * RAW (the `<user_query>` wrapper only exists in `chat_history.jsonl`) and closes every turn with
 * `turn_completed` + `stop_reason`. Nothing else (chat_history, events, rewind points, the
 * per-cwd `prompt_history.jsonl`, subagent logs nested deeper) is read as the transcript.
 */

/** The log that carries prompts, answers and turn boundaries. */
export const GROK_TRANSCRIPT_FILE = "updates.jsonl";

/** One line of `updates.jsonl`, already decoded. */
export interface GrokUpdateLine {
  readonly timestamp?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** Over this cap the most recently written are kept, never none (an empty list blinded the harvest). */
export const MAX_GROK_SESSIONS = 1_000;
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CORRELATION_MEMBER = /"cauce_correlation_id":"[a-f0-9]{64}"/gu;
const SUMMARY_FILE = "summary.json";
const MAX_SUMMARY_BYTES = 256 * 1024;
/** `summary.json` `session_kind` of folders that are no conversation (one per subagent, never pruned). */
const CHILD_SESSION_KINDS: ReadonlySet<string> = new Set(["subagent"]);
const childSessionCache = new Map<string, boolean>(); // A folder's kind never changes once written.

/** Root of every conversation of this grok home, whatever cwd created it. */
export function grokSessionsRoot(grokHome: string): string {
  return join(grokHome.replace(/\/+$/u, ""), "sessions");
}

/** The conversation id of a transcript: the name of its session folder. */
export function grokSessionIdOf(file: string): string {
  return basename(dirname(file));
}

/** Whether `value` has the shape of a grok session id (UUID; grok mints v7, sortable by time). */
export function isGrokSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

interface Listing { readonly files: readonly string[]; readonly unreadable: boolean }

async function isChildSession(folder: string): Promise<boolean> {
  const cached = childSessionCache.get(folder);
  if (cached !== undefined) return cached;
  let handle;
  try {
    handle = await open(join(folder, SUMMARY_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK | O_CLOEXEC);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SUMMARY_BYTES) return false;
    const summary = asObject(JSON.parse(await handle.readFile("utf8")) as unknown);
    const sessionKind = asString(summary?.session_kind);
    if (sessionKind === undefined) return false;
    const child = CHILD_SESSION_KINDS.has(sessionKind);
    childSessionCache.set(folder, child);
    return child;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function modifiedAt(file: string): Promise<number> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Every `sessions/<group>/<id>/updates.jsonl` of a conversation, oldest conversation first.
 *
 * ALL cwd groups are listed, not only the workspace's: `--resume <id>` reopens a conversation in
 * the folder where it was born (measured: the DM of hades lives under `/home/claw` whatever cwd
 * the TUI runs in), so restricting to one group would lose the very conversation being shared.
 * Subagent sessions are left out. Session ids are UUIDv7, so sorting by id is sorting by creation
 * time, which is what `hasValidTerminalEnvelope` relies on to try the newest first.
 */
async function listGrokSessionFiles(grokHome: string, limit = MAX_GROK_SESSIONS): Promise<Listing> {
  const root = grokSessionsRoot(grokHome);
  let groups: Dirent[];
  try {
    groups = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return { files: [], unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  let found: { id: string; file: string }[] = [];
  let unreadable = false;
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    let sessions: Dirent[];
    try {
      sessions = await readdir(join(root, group.name), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const folder = join(root, group.name, session.name);
      if (await isChildSession(folder)) continue;
      found.push({ id: session.name, file: join(folder, GROK_TRANSCRIPT_FILE) });
    }
  }
  if (found.length > limit) {
    const dated = await Promise.all(found.map(async (entry) => ({ ...entry, at: await modifiedAt(entry.file) })));
    dated.sort((left, right) => right.at - left.at);
    found = dated.slice(0, Math.max(0, limit)).map(({ id, file }) => ({ id, file }));
  }
  found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1
    : left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  return { files: found.map((entry) => entry.file), unreadable };
}

/** Transcript files for polling: a missing or unreadable tree is an empty list, not a failure. */
export async function grokSessionFiles(grokHome: string): Promise<readonly string[]> {
  return (await listGrokSessionFiles(grokHome)).files;
}

/** Same listing, but an unreadable tree fails instead of looking empty (for attestations). */
export async function grokSessionFilesStrict(grokHome: string): Promise<readonly string[]> {
  const listing = await listGrokSessionFiles(grokHome);
  if (listing.unreadable) throw new Error("grok session tree could not be listed");
  return listing.files;
}

/**
 * Whether grok has ANY conversation with at least one prompt.
 *
 * A bare launch creates its folder at once but writes `updates.jsonl` only with the first
 * prompt, so an empty launch (a TUI restarted before its first turn) is not history. Any real
 * conversation, in any cwd, is: the shared TUI must not pick one on its own.
 */
export async function grokConversationHistoryState(
  grokHome: string,
): Promise<"absent" | "present" | "unreadable"> {
  const listing = await listGrokSessionFiles(grokHome);
  for (const file of listing.files) {
    try {
      const info = await lstat(file);
      if (info.isFile() && info.size > 0) return "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
    }
  }
  return listing.unreadable ? "unreadable" : "absent";
}

function ownedAndPrivate(metadata: { uid: bigint; mode: bigint }): boolean {
  const euid = process.geteuid?.();
  return euid !== undefined && metadata.uid === BigInt(euid) && (metadata.mode & 0o022n) === 0n;
}

/**
 * The exact conversation folder for `nativeId`, or `undefined` unless there is exactly one, with
 * no symlink on the way, owned by this uid and not writable by anyone else, holding a non-empty
 * `updates.jsonl`. It is what makes `--resume <id>` safe to put on the TUI's argv.
 */
export async function grokSessionIsSecure(grokHome: string, nativeId: string): Promise<boolean> {
  if (!isGrokSessionId(nativeId)) return false;
  const root = grokSessionsRoot(grokHome);
  try {
    if (await realpath(root) !== normalize(root)) return false;
    const groups = await readdir(root, { withFileTypes: true });
    const matches: string[] = [];
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const candidate = join(root, group.name, nativeId);
      try {
        const info = await lstat(candidate);
        if (info.isDirectory()) matches.push(candidate);
        else if (info.isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    const directory = matches.length === 1 ? matches[0] : undefined;
    if (directory === undefined) return false;
    for (const folder of [dirname(directory), directory]) {
      const handle = await open(
        folder,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
      );
      try {
        const metadata = await handle.stat({ bigint: true });
        if (!metadata.isDirectory() || !ownedAndPrivate(metadata)) return false;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    const transcript = await open(
      join(directory, GROK_TRANSCRIPT_FILE),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
    );
    try {
      const metadata = await transcript.stat({ bigint: true });
      return metadata.isFile() && ownedAndPrivate(metadata) && metadata.nlink === 1n
        && metadata.size > 0n;
    } finally {
      await transcript.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

/** A fresh session id grok accepts for `--session-id`, time-ordered like the ones it mints (v7). */
export function newGrokSessionId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let millis = BigInt(Math.max(0, Math.floor(now)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(millis & 0xffn);
    millis >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function params(line: GrokUpdateLine | undefined): Record<string, unknown> | undefined {
  return asObject(line?.params);
}

function update(line: GrokUpdateLine | undefined): Record<string, unknown> | undefined {
  return asObject(params(line)?.update);
}

function kind(line: GrokUpdateLine | undefined): string | undefined {
  return asString(update(line)?.sessionUpdate);
}

function sessionOf(line: GrokUpdateLine | undefined): string | undefined {
  return asString(params(line)?.sessionId);
}

function eventIdOf(line: GrokUpdateLine | undefined): string | undefined {
  return asString(asObject(params(line)?._meta)?.eventId);
}

/** The turn a line belongs to: `_meta.promptId` on chunks, `prompt_id` on `turn_completed`. */
function promptIdOf(line: GrokUpdateLine | undefined): string | undefined {
  return asString(asObject(params(line)?._meta)?.promptId) ?? asString(update(line)?.prompt_id);
}

/** The text of a chunk: `content` is one `{type:"text"}` block, or a list of them. */
function textOf(line: GrokUpdateLine | undefined): string | undefined {
  const content = update(line)?.content;
  const blocks = Array.isArray(content) ? content : [content];
  const parts = blocks
    .map((block) => asObject(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""));
  return parts.length === 0 ? undefined : parts.join("");
}

const USER = "user_message_chunk";
const MESSAGE = "agent_message_chunk";
const COMPLETED = "turn_completed";
const TOOL_ACTIVITY = new Set(["tool_call", "tool_call_update"]);

/**
 * Prompt as grok may have recorded it.
 *
 * `updates.jsonl` keeps it byte for byte (measured with a 6 KB paste with accents and quotes), but
 * a trailing newline may be trimmed on submit and `chat_history.jsonl` wraps it in `<user_query>`.
 * Both are undone before comparing, so the same matcher works for either log.
 */
function normalizedPrompt(text: string): string {
  const unix = text.replace(/\r\n/gu, "\n");
  const wrapped = /^\s*<user_query>\n?([\s\S]*?)\n?<\/user_query>\s*$/u.exec(unix);
  return (wrapped?.[1] ?? unix).replace(/\s+$/u, "");
}

/** The runner's nonce member, else the prompt's LAST one (the transport block goes after the body). */
function correlationMember(promptText: string, correlationId: string | undefined): string | undefined {
  if (correlationId !== undefined) {
    return /^[a-f0-9]{64}$/u.test(correlationId)
      ? `"cauce_correlation_id":${JSON.stringify(correlationId)}`
      : undefined;
  }
  return [...promptText.matchAll(CORRELATION_MEMBER)].at(-1)?.[0];
}

/**
 * The prompt is this delivery's when it is the same text, or when it carries this delivery's
 * 256-bit correlation member: nothing but our paste can contain that nonce inside a user prompt,
 * so a TUI that re-renders or wraps the paste still correlates.
 */
function isOurPrompt(recorded: string, promptText: string, correlationId?: string): boolean {
  if (normalizedPrompt(recorded) === normalizedPrompt(promptText)) return true;
  const member = correlationMember(promptText, correlationId);
  return member !== undefined && recorded.includes(member);
}

/** Stable handle for the user line: grok's event id, or its position in the slice. */
function keyOf(entries: readonly GrokUpdateLine[], index: number): string {
  const eventId = eventIdOf(entries[index]);
  return eventId === undefined ? `index:${String(index)}` : `event:${eventId}`;
}

function indexOfKey(entries: readonly GrokUpdateLine[], key: string): number | undefined {
  if (key.startsWith("index:")) {
    const index = Number(key.slice("index:".length));
    return Number.isInteger(index) && kind(entries[index]) === USER ? index : undefined;
  }
  if (!key.startsWith("event:")) return undefined;
  const eventId = key.slice("event:".length);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (kind(entries[index]) === USER && eventIdOf(entries[index]) === eventId) return index;
  }
  return undefined;
}

/** The last user prompt (its contiguous chunks joined); grok's wake turns write no user line. */
function lastGrokPrompt(entries: readonly GrokUpdateLine[]): string | undefined {
  let end = entries.length - 1;
  while (end >= 0 && kind(entries[end]) !== USER) end -= 1;
  let start = end;
  while (start > 0 && kind(entries[start - 1]) === USER) start -= 1;
  const text = entries.slice(Math.max(start, 0), end + 1).map(textOf).join("");
  return end < 0 || text.length === 0 ? undefined : normalizedPrompt(text);
}

function findInjectedGrokTurn(
  file: string,
  entries: readonly GrokUpdateLine[],
  promptText: string,
  correlationId?: string,
): InjectedTurn | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entries[index];
    if (kind(line) !== USER) continue;
    const text = textOf(line);
    if (text === undefined || !isOurPrompt(text, promptText, correlationId)) continue;
    const sessionId = sessionOf(line) ?? grokSessionIdOf(file);
    return { key: keyOf(entries, index), sessionId };
  }
  return undefined;
}

interface GrokTurn {
  readonly promptId?: string;
  readonly body: readonly GrokUpdateLine[];
  readonly completion?: GrokUpdateLine;
  readonly completionIndex?: number;
}

function bodyOf(
  entries: readonly GrokUpdateLine[],
  from: number,
  to: number,
  promptId: string,
): readonly GrokUpdateLine[] {
  const body: GrokUpdateLine[] = [];
  for (let index = from; index < to; index += 1) {
    const line = entries[index];
    const tagged = promptIdOf(line);
    if (line !== undefined && (tagged === undefined || tagged === promptId)) body.push(line);
  }
  return body;
}

/**
 * Everything the turn opened by the user line at `start` wrote, and its close if it arrived.
 *
 * grok runs one turn at a time per conversation: the turn's `promptId` is the first one tagged
 * after the prompt, and its close is the `turn_completed` with that `prompt_id`. A turn that
 * closes before tagging anything (instant cancel) is closed by the first `turn_completed` before
 * any other prompt.
 */
function turnFrom(entries: readonly GrokUpdateLine[], start: number): GrokTurn {
  let promptId: string | undefined;
  const body: GrokUpdateLine[] = [];
  for (let index = start + 1; index < entries.length; index += 1) {
    const line = entries[index];
    const type = kind(line);
    if (type === USER && promptId === undefined) break;
    if (type === COMPLETED && line !== undefined) {
      const closes = asString(update(line)?.prompt_id);
      if (promptId === undefined || closes === promptId) {
        const turnId = promptId ?? closes;
        return turnId === undefined
          ? { body, completion: line, completionIndex: index }
          : { promptId: turnId, body, completion: line, completionIndex: index };
      }
      continue;
    }
    const tagged = promptIdOf(line);
    if (promptId === undefined && tagged !== undefined) promptId = tagged;
    if (line !== undefined && (tagged === undefined || tagged === promptId)) body.push(line);
  }
  return { ...(promptId === undefined ? {} : { promptId }), body };
}

const SUBAGENT_SPAWNED = "subagent_spawned";
const SUBAGENT_FINISHED = "subagent_finished";
const TASK_BACKGROUNDED = "task_backgrounded";
const TASK_COMPLETED = "task_completed";
const TOOL_CALL = "tool_call";

interface ClosedTurn {
  readonly body: readonly GrokUpdateLine[];
  readonly completion: GrokUpdateLine;
}

/**
 * The delivery = the pasted turn + the background work it started + the wake turns that work causes
 * (in the TUI subagents and background commands outlive the turn and wake the agent, `will_wake`;
 * the owner typing during `get_command_or_subagent_output` cancels it). Work is attributed by
 * `subagent_spawned.parent_prompt_id` and `task_backgrounded.tool_call_id` -> `tool_call`; a wake is
 * the first turn tagged after a `will_wake` finish with no user line since the last close (grok's wake
 * prompt was never measured: with a user line the delivery lingers until `backgroundWaitMs`).
 */
interface GrokChain {
  readonly state: "running" | "lingering" | "settled"; // lingering: all turns closed, work pending.
  readonly last?: ClosedTurn;
  readonly progress: string; // Changes whenever the chain or the conversation moves.
}

function grokChain(entries: readonly GrokUpdateLine[], start: number): GrokChain {
  const first = turnFrom(entries, start);
  if (first.completion === undefined || first.completionIndex === undefined) {
    return { state: "running", progress: "" };
  }
  const chain = new Set<string>(first.promptId === undefined ? [] : [first.promptId]);
  let last: ClosedTurn = { body: first.body, completion: first.completion };
  const toolTurns = new Map<string, string>();
  const subagents = new Set<string>();
  const tasks = new Set<string>();
  let wakeDue = false;
  let finished = 0;
  let lastUser = start;
  let lastClose = first.completionIndex;
  let open: { readonly promptId: string; readonly from: number } | undefined;
  for (let index = start + 1; index < entries.length; index += 1) {
    const line = entries[index];
    const type = kind(line);
    const payload = update(line);
    if (type === TOOL_CALL) {
      const call = asString(payload?.toolCallId);
      const owner = promptIdOf(line);
      if (call !== undefined && owner !== undefined) toolTurns.set(call, owner);
    } else if (type === SUBAGENT_SPAWNED) {
      const parent = asString(payload?.parent_prompt_id);
      const id = asString(payload?.subagent_id) ?? asString(payload?.child_session_id);
      if (parent !== undefined && id !== undefined && chain.has(parent)) subagents.add(id);
      continue;
    } else if (type === TASK_BACKGROUNDED) {
      const call = asString(payload?.tool_call_id);
      const task = asString(payload?.task_id);
      const owner = call === undefined ? undefined : toolTurns.get(call);
      if (task !== undefined && owner !== undefined && chain.has(owner)) tasks.add(task);
      continue;
    } else if (type === SUBAGENT_FINISHED || type === TASK_COMPLETED) {
      const id = type === SUBAGENT_FINISHED
        ? asString(payload?.subagent_id) ?? asString(payload?.child_session_id)
        : asString(asObject(payload?.task_snapshot)?.task_id);
      const pending = type === SUBAGENT_FINISHED ? subagents : tasks;
      if (id !== undefined && pending.delete(id)) {
        finished += 1;
        if (payload?.will_wake === true) wakeDue = true;
      }
      continue;
    }
    if (index <= first.completionIndex) continue;
    if (type === USER) {
      lastUser = index;
      continue;
    }
    if (type === COMPLETED) {
      const closes = asString(payload?.prompt_id);
      if (open !== undefined && closes === open.promptId && line !== undefined) {
        last = { body: bodyOf(entries, open.from, index, open.promptId), completion: line };
        open = undefined;
      } else if (wakeDue && lastUser < lastClose) {
        wakeDue = false; // A wake answered silently: grok closed it without tagging anything.
      }
      lastClose = index;
      continue;
    }
    const tagged = promptIdOf(line);
    if (open === undefined && wakeDue && tagged !== undefined && !chain.has(tagged)
      && lastUser < lastClose) {
      chain.add(tagged);
      open = { promptId: tagged, from: index };
      wakeDue = false;
    }
  }
  const progress = `${String(chain.size)}:${String(finished)}:${String(lastClose)}:${String(lastUser)}`;
  if (open !== undefined) return { state: "running", last, progress };
  return subagents.size > 0 || tasks.size > 0 || wakeDue
    ? { state: "lingering", last, progress }
    : { state: "settled", last, progress };
}

function outcomeOf(entries: readonly GrokUpdateLine[], start: number, turn: ClosedTurn): TurnOutcome {
  const sessionId = sessionOf(turn.completion) ?? sessionOf(entries[start]);
  const stopReason = asString(update(turn.completion)?.stop_reason) ?? "sin stop_reason";
  if (stopReason !== "end_turn") {
    return {
      kind: "failed",
      detail: stopReason === "cancelled"
        ? "el turno se canceló dentro de la terminal (Ctrl+C) antes de terminar"
        : `el turno terminó en la terminal con stop_reason '${stopReason}'`,
    };
  }
  // An empty text is still an answer: after a `cauce_reply` deposit grok may close with no text,
  // and the adapter takes the deposit; without one, the parser reports the silent turn as failed.
  const text = finalMessage(turn.body);
  return sessionId === undefined ? { kind: "answer", text } : { kind: "answer", text, sessionId };
}

/**
 * The answer text of a turn: the assistant text AFTER its last tool activity.
 *
 * Text written before a tool call ("voy a revisar…") is narration, not the answer; gluing it to
 * the final message would break a JSON envelope. If the turn ended on tools, the last text written.
 */
function messageSegments(body: readonly GrokUpdateLine[]): readonly string[] {
  const segments: string[] = [];
  let current: string[] = [];
  const close = (): void => {
    if (current.length > 0) segments.push(current.join(""));
    current = [];
  };
  for (const line of body) {
    const type = kind(line);
    if (type === MESSAGE) current.push(textOf(line) ?? "");
    else if (type !== undefined && TOOL_ACTIVITY.has(type)) close();
  }
  close();
  return segments;
}

function finalMessage(body: readonly GrokUpdateLine[]): string {
  const segments = messageSegments(body).filter((segment) => segment.trim().length > 0);
  return segments.at(-1) ?? "";
}

function findGrokOutcome(entries: readonly GrokUpdateLine[], key: string): TurnOutcome | undefined {
  const start = indexOfKey(entries, key);
  if (start === undefined) return undefined;
  const chain = grokChain(entries, start);
  return chain.state === "settled" && chain.last !== undefined
    ? outcomeOf(entries, start, chain.last)
    : undefined;
}

function findGrokLingering(
  entries: readonly GrokUpdateLine[],
  key: string,
): { readonly outcome: TurnOutcome; readonly progress: string } | undefined {
  const start = indexOfKey(entries, key);
  if (start === undefined) return undefined;
  const chain = grokChain(entries, start);
  return chain.state === "lingering" && chain.last !== undefined
    ? { outcome: outcomeOf(entries, start, chain.last), progress: chain.progress }
    : undefined;
}

/**
 * A correlated envelope among the assistant texts, newest first.
 *
 * Each message segment and each turn's final text is a candidate: grok stores the message
 * coalesced, so an envelope is normally one `agent_message_chunk`.
 */
function findGrokEnvelope(
  entries: readonly GrokUpdateLine[],
  correlationId: string,
  desde?: string,
): TurnOutcome | undefined {
  const floor = desde === undefined ? 0 : (indexOfKey(entries, desde) ?? 0);
  const candidates: { text: string; sessionId?: string }[] = [];
  let current: string[] = [];
  let currentSession: string | undefined;
  const close = (): void => {
    if (current.length > 0) {
      candidates.push({
        text: current.join(""),
        ...(currentSession === undefined ? {} : { sessionId: currentSession }),
      });
    }
    current = [];
    currentSession = undefined;
  };
  let promptId: string | undefined;
  for (let index = floor; index < entries.length; index += 1) {
    const line = entries[index];
    const type = kind(line);
    if (type === MESSAGE) {
      const tagged = promptIdOf(line);
      if (tagged !== promptId) close();
      promptId = tagged;
      current.push(textOf(line) ?? "");
      currentSession ??= sessionOf(line);
      continue;
    }
    if (type === USER || type === COMPLETED || (type !== undefined && TOOL_ACTIVITY.has(type))) {
      close();
      promptId = undefined;
    }
  }
  close();
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined || !envelopeHasCorrelation(candidate.text, correlationId)) continue;
    const text = stripJsonFence(candidate.text);
    return candidate.sessionId === undefined
      ? { kind: "answer", text }
      : { kind: "answer", text, sessionId: candidate.sessionId };
  }
  return undefined;
}

/**
 * Compactions among the new lines. grok 1.0.41's exact update for it was not measured; any
 * update whose type names a compaction is reported, with its event id so it is said only once.
 */
function grokCompactions(appended: readonly GrokUpdateLine[]): readonly CompactionNotice[] {
  const notices: CompactionNotice[] = [];
  for (const [index, line] of appended.entries()) {
    const type = kind(line);
    if (type === undefined || !/compact/iu.test(type)) continue;
    const id = eventIdOf(line)
      ?? (typeof line.timestamp === "number" || typeof line.timestamp === "string"
        ? `${type}@${String(line.timestamp)}` : `${type}#${String(index)}`);
    notices.push({ id, detail: `la terminal compactó su contexto durante este turno (${type})` });
  }
  return notices;
}

/**
 * Creates a `TranscriptReader` over the grok TUI's `updates.jsonl` logs.
 *
 * `startedTurn` is NOT declared, on purpose: grok may legitimately run the pasted prompt later
 * (queued behind a turn that began under the barrier), and a 30 s "never started" verdict would
 * quarantine a turn that is about to run. The paste is proven by its own user line instead.
 */
export function grokTranscript(grokHome: string): TranscriptReader<GrokUpdateLine> {
  return {
    files: () => grokSessionFiles(grokHome),
    read: (file, offset) => readJsonlSince<GrokUpdateLine>(file, offset),
    findInjected: findInjectedGrokTurn,
    findAnswer: findGrokOutcome,
    lingering: findGrokLingering,
    findEnvelope: findGrokEnvelope,
    lastUserPrompt: lastGrokPrompt,
    compactions: grokCompactions,
    // The shape `parseGrokOutput` accepts from `grok --output-format json`.
    stdout: (text, sessionId) => JSON.stringify({
      text,
      stopReason: "end_turn",
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  };
}

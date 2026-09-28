import { constants as fsConstants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { envelopeHasCorrelation, isEnvelopeText, stripJsonFence } from "./envelope.js";
import { readJsonlSince } from "./rollout.js";
import type { CompactionNotice, InjectedTurn, TranscriptReader, TurnOutcome } from "./types.js";

/**
 * Reader and analyzer for the session log of the Muse Code TUI (measured on Muse 1.4.0).
 *
 * Muse keeps one folder per conversation: `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/`, and in
 * it `session.jsonl`, the durable log `muse resume` rebuilds the conversation from. Each line is a
 * record `{stream:{kind:"session",id}, sequence, payload_type, payload}`; some lines are a
 * `retained_frame` wrapping several records as `children[].record_json` (JSON inside a string).
 *
 * The three records a turn is made of (all `payload_type:"runtime.session"`, `payload.kind:"run"`):
 * - `runtime.user_intent.accepted` carries the prompt EXACTLY as submitted (`model_messages`) and
 *   its `intent_id`. On an idle TUI the run it opens has `run_id === intent_id`; submitted while a
 *   turn runs, Muse queues it as a steer and later runs it as its own run with that same id.
 * - `event.kind:"assistant_message_committed"` with the text of each assistant message;
 * - `event.kind:"terminal"` with `terminal:"completed"|…` closes the run.
 *
 * Subagent logs live deeper (`<id>/subagent/<child>/session.jsonl`) and are never listed.
 */

export const MUSE_TRANSCRIPT_FILE = "session.jsonl";

/** One raw line of `session.jsonl`, already decoded. It may be a frame holding several records. */
export interface MuseLogLine {
  readonly retained_frame?: unknown;
  readonly children?: unknown;
  readonly stream?: unknown;
  readonly payload_type?: unknown;
  readonly payload?: unknown;
}

/** Over this cap the most recently written are kept, never none. */
export const MAX_MUSE_SESSIONS = 1_000;
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_PART = [/^[0-9]{4}$/u, /^[0-9]{2}$/u, /^[0-9]{2}$/u] as const;
const CORRELATION_MEMBER = /"cauce_correlation_id":"[a-f0-9]{64}"/gu;

/** Root of every conversation of this Muse data directory (`$XDG_DATA_HOME/muse`). */
export function museSessionsRoot(museData: string): string {
  return join(museData.replace(/\/+$/u, ""), "sessions");
}

/** The conversation id of a transcript: the name of its session folder. */
export function museSessionIdOf(file: string): string {
  return basename(dirname(file));
}

export function isMuseSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

interface Listing { readonly files: readonly string[]; readonly unreadable: boolean }

async function directories(path: string, pattern?: RegExp): Promise<{ names: string[]; unreadable: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    return { names: [], unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  return {
    names: entries.filter((entry) => entry.isDirectory() && (pattern === undefined || pattern.test(entry.name)))
      .map((entry) => entry.name),
    unreadable: false,
  };
}

async function modifiedAt(file: string): Promise<number> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Every `sessions/YYYY/MM/DD/<id>/session.jsonl`, oldest first by id (Muse mints UUIDv7, so the
 * id order is creation order). Folders that are not a session id (`.msp-view-v1`, caches) are
 * skipped, and so is any folder without a transcript yet.
 */
async function listMuseSessionFiles(museData: string, limit = MAX_MUSE_SESSIONS): Promise<Listing> {
  const root = museSessionsRoot(museData);
  let unreadable = false;
  let found: { id: string; file: string }[] = [];
  const years = await directories(root, DATE_PART[0]);
  unreadable ||= years.unreadable;
  for (const year of years.names) {
    const months = await directories(join(root, year), DATE_PART[1]);
    unreadable ||= months.unreadable;
    for (const month of months.names) {
      const days = await directories(join(root, year, month), DATE_PART[2]);
      unreadable ||= days.unreadable;
      for (const day of days.names) {
        const sessions = await directories(join(root, year, month, day), SESSION_ID);
        unreadable ||= sessions.unreadable;
        for (const id of sessions.names) {
          const file = join(root, year, month, day, id, MUSE_TRANSCRIPT_FILE);
          try {
            if ((await lstat(file)).isFile()) found.push({ id, file });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
          }
        }
      }
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
export async function museSessionFiles(museData: string): Promise<readonly string[]> {
  return (await listMuseSessionFiles(museData)).files;
}

/** Same listing, but an unreadable tree fails instead of looking empty (for attestations). */
export async function museSessionFilesStrict(museData: string): Promise<readonly string[]> {
  const listing = await listMuseSessionFiles(museData);
  if (listing.unreadable) throw new Error("muse session tree could not be listed");
  return listing.files;
}

/** Whether this Muse data directory holds ANY conversation with a non-empty log. */
export async function museConversationHistoryState(
  museData: string,
): Promise<"absent" | "present" | "unreadable"> {
  const listing = await listMuseSessionFiles(museData);
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
 * Whether `nativeId` names exactly one conversation of this data directory, with no symlink on
 * the way, owned by this uid, not writable by anyone else and with a non-empty log. It is what
 * makes `resume <id>` safe to put on the TUI's argv.
 */
export async function museSessionIsSecure(museData: string, nativeId: string): Promise<boolean> {
  if (!isMuseSessionId(nativeId)) return false;
  const root = museSessionsRoot(museData);
  try {
    if (await realpath(root) !== normalize(root)) return false;
    const matches = (await listMuseSessionFiles(museData, Number.MAX_SAFE_INTEGER)).files
      .filter((file) => museSessionIdOf(file) === nativeId);
    const transcriptPath = matches.length === 1 ? matches[0] : undefined;
    if (transcriptPath === undefined) return false;
    const directory = dirname(transcriptPath);
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
      transcriptPath,
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

/** A single decoded record, whether it came as its own line or inside a retained frame. */
interface MuseRecord {
  readonly sessionId?: string;
  readonly payloadType?: string;
  readonly payload?: Record<string, unknown>;
}

function recordOf(value: Record<string, unknown>): MuseRecord {
  const stream = asObject(value.stream);
  const sessionId = stream?.kind === "session" ? asString(stream.id) : undefined;
  const payloadType = asString(value.payload_type);
  const payload = asObject(value.payload);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(payloadType === undefined ? {} : { payloadType }),
    ...(payload === undefined ? {} : { payload }),
  };
}

/** Flattens frames: a line with `children[].record_json` yields each child record, in order. */
function recordsOf(entries: readonly MuseLogLine[]): readonly MuseRecord[] {
  const records: MuseRecord[] = [];
  for (const entry of entries) {
    const line = asObject(entry);
    if (line === undefined) continue;
    if (Array.isArray(line.children)) {
      for (const child of line.children) {
        const raw = asObject(child)?.record_json;
        if (typeof raw !== "string") continue;
        try {
          const decoded = asObject(JSON.parse(raw) as unknown);
          if (decoded !== undefined) records.push(recordOf(decoded));
        } catch { /* A malformed child is not a turn of ours. */ }
      }
      continue;
    }
    records.push(recordOf(line));
  }
  return records;
}

interface RunEvent {
  readonly runId: string;
  readonly kind: string;
  readonly event: Record<string, unknown>;
  readonly sessionId?: string;
}

function runEvent(record: MuseRecord): RunEvent | undefined {
  if (record.payloadType !== "runtime.session" || record.payload?.kind !== "run") return undefined;
  const event = asObject(record.payload.event);
  const runId = asString(record.payload.run_id);
  const kind = asString(event?.kind);
  if (event === undefined || runId === undefined || kind === undefined) return undefined;
  return { runId, kind, event, ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }) };
}

/** The prompt text of a `runtime.user_intent.accepted`: every text block of its model messages. */
function intentText(record: MuseRecord): string | undefined {
  const messages = record.payload?.model_messages;
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (const message of messages) {
    const content = asObject(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const object = asObject(block);
      if (object?.kind === "text" && typeof object.text === "string") parts.push(object.text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function normalizedPrompt(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\s+$/u, "");
}

function correlationMember(promptText: string, correlationId: string | undefined): string | undefined {
  if (correlationId !== undefined) {
    return /^[a-f0-9]{64}$/u.test(correlationId)
      ? `"cauce_correlation_id":${JSON.stringify(correlationId)}`
      : undefined;
  }
  return [...promptText.matchAll(CORRELATION_MEMBER)].at(-1)?.[0];
}

/** Same text, or it carries this delivery's 256-bit correlation member (nothing else can). */
function isOurPrompt(recorded: string, promptText: string, correlationId?: string): boolean {
  if (normalizedPrompt(recorded) === normalizedPrompt(promptText)) return true;
  const member = correlationMember(promptText, correlationId);
  return member !== undefined && recorded.includes(member);
}

function findInjectedMuseTurn(
  file: string,
  entries: readonly MuseLogLine[],
  promptText: string,
  correlationId?: string,
): InjectedTurn | undefined {
  const records = recordsOf(entries);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.payloadType !== "runtime.user_intent.accepted") continue;
    const intentId = asString(record.payload?.intent_id);
    const text = intentText(record);
    if (intentId === undefined || text === undefined || !isOurPrompt(text, promptText, correlationId)) continue;
    return { key: intentId, sessionId: record.sessionId ?? museSessionIdOf(file) };
  }
  return undefined;
}

/** The final text of a run: its LAST committed assistant message (earlier ones precede tools). */
function findMuseOutcome(entries: readonly MuseLogLine[], key: string): TurnOutcome | undefined {
  let text = "";
  let sessionId: string | undefined;
  for (const record of recordsOf(entries)) {
    const event = runEvent(record);
    if (event?.runId !== key) continue;
    sessionId ??= event.sessionId;
    if (event.kind === "assistant_message_committed" && typeof event.event.text === "string"
      && event.event.text.trim().length > 0) {
      text = event.event.text;
      continue;
    }
    if (event.kind !== "terminal") continue;
    const terminal = asString(event.event.terminal) ?? "sin terminal";
    if (terminal !== "completed") {
      const reason = asString(event.event.reason) ?? asString(asObject(event.event.reason)?.message);
      return {
        kind: "failed",
        detail: terminal === "cancelled" || terminal === "interrupted"
          ? "el turno se interrumpió dentro de la terminal (Esc) antes de terminar"
          : `el turno terminó en la terminal como '${terminal}'${reason === undefined ? "" : `: ${reason}`}`,
      };
    }
    // An empty text is still an answer; without an envelope the parser reports the silent turn.
    return sessionId === undefined ? { kind: "answer", text } : { kind: "answer", text, sessionId };
  }
  return undefined;
}

/**
 * The run already committed its envelope but has not closed: Muse's "Double checking" phase.
 *
 * Measured on hegel (2026-09-28): after the final message Muse runs its verify reminder for ~9 s
 * (`◇ Double checking … esc to interrupt`) and only then writes `terminal`. Without this the runner
 * saw an envelope with no close and rescued it as a MERGED turn, telling the sender a falsehood.
 * Only an envelope-shaped last message with no tool call after it counts: an interim message
 * followed by more work is still a running turn, never an answer.
 */
function findMuseLingering(
  entries: readonly MuseLogLine[],
  key: string,
): { readonly outcome: TurnOutcome; readonly progress: string } | undefined {
  let last: string | undefined;
  let sessionId: string | undefined;
  let records = 0;
  for (const record of recordsOf(entries)) {
    const event = runEvent(record);
    if (event?.runId !== key) continue;
    records += 1;
    sessionId ??= event.sessionId;
    if (event.kind === "terminal") return undefined;
    if (event.kind === "assistant_tool_calls_committed") last = undefined;
    if (event.kind === "assistant_message_committed" && typeof event.event.text === "string"
      && event.event.text.trim().length > 0) last = event.event.text;
  }
  if (last === undefined || !isEnvelopeText(stripJsonFence(last))) return undefined;
  const outcome: TurnOutcome = sessionId === undefined
    ? { kind: "answer", text: last }
    : { kind: "answer", text: last, sessionId };
  return { outcome, progress: String(records) };
}

/** A correlated envelope among the committed assistant messages, newest first. */
function findMuseEnvelope(
  entries: readonly MuseLogLine[],
  correlationId: string,
  desde?: string,
): TurnOutcome | undefined {
  const candidates: { text: string; sessionId?: string }[] = [];
  let open = desde === undefined;
  for (const record of recordsOf(entries)) {
    if (!open && record.payloadType === "runtime.user_intent.accepted"
      && asString(record.payload?.intent_id) === desde) open = true;
    if (!open) continue;
    const event = runEvent(record);
    if (event?.kind !== "assistant_message_committed" || typeof event.event.text !== "string") continue;
    candidates.push({
      text: event.event.text,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    });
  }
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

/** `context_compaction_installed` is the record Muse writes when it actually compacts. */
function museCompactions(appended: readonly MuseLogLine[]): readonly CompactionNotice[] {
  const notices: CompactionNotice[] = [];
  for (const record of recordsOf(appended)) {
    const event = runEvent(record);
    if (event?.kind !== "context_compaction_installed") continue;
    const id = asString(event.event.install_id) ?? asString(event.event.candidate_id) ?? `${event.runId}:compaction`;
    notices.push({ id, detail: "la terminal compactó su contexto durante este turno" });
  }
  return notices;
}

/** Whether any turn started among the new records (the pasted one or another). */
function museStartedTurn(appended: readonly MuseLogLine[]): boolean {
  return recordsOf(appended).some((record) => record.payloadType === "runtime.user_intent.accepted"
    || runEvent(record)?.kind === "started");
}

/**
 * The line `parseMuseOutput` reads from `muse exec --json`: a session record and a completed
 * `run_terminal` with the final text.
 */
export function museStdout(text: string, sessionId: string | undefined): string {
  return JSON.stringify({
    schema_version: 1,
    ...(sessionId === undefined ? {} : { stream: { kind: "session", id: sessionId } }),
    record_type: "event",
    payload_type: "run.terminal.completed",
    payload: { kind: "run_terminal", terminal: "completed", reason: null, text },
  });
}

/** Creates a `TranscriptReader` over the Muse TUI's `session.jsonl` logs. */
export function museTranscript(museData: string): TranscriptReader<MuseLogLine> {
  return {
    files: () => museSessionFiles(museData),
    read: (file, offset) => readJsonlSince<MuseLogLine>(file, offset),
    findInjected: findInjectedMuseTurn,
    findAnswer: findMuseOutcome,
    lingering: findMuseLingering,
    findEnvelope: findMuseEnvelope,
    compactions: museCompactions,
    startedTurn: museStartedTurn,
    stdout: museStdout,
  };
}

/**
 * Re-creates `~/.config/muse` -> the alias's persistent login when it is missing.
 *
 * The login lives under `~/.local/share/cauce-v3/config/<alias>/.config/muse` (a mounted volume);
 * `~/.config` is NOT one, so re-flattening the container drops the link and the TUI would start
 * logged out. The headless bridge (muse-cauce) repairs it per turn; the shared TUI never goes
 * through it, so whoever creates the pane repairs it first. An existing entry is never touched.
 */
export async function ensureMuseLoginLink(home: string, alias: string): Promise<"present" | "linked" | "absent"> {
  const link = join(home, ".config", "muse");
  const login = join(home, ".local", "share", "cauce-v3", "config", alias, ".config", "muse");
  try {
    await lstat(link);
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "present";
  }
  try {
    if (!(await lstat(login)).isDirectory()) return "absent";
    await mkdir(dirname(link), { recursive: true });
    await symlink(login, link);
    return "linked";
  } catch {
    return "absent";
  }
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { envelopeHasCorrelation, stripJsonFence } from "./envelope.js";
import { transcriptDirectoryIn } from "./session.js";
import type { TranscriptReader, TranscriptSlice } from "./types.js";

export { stripJsonFence } from "./envelope.js";

/**
 * Reader and analyzer for JSONL transcripts produced by Claude.
 */

export interface TranscriptEntry {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly uuid?: unknown;
  readonly parentUuid?: unknown;
  /**
   * The real parent when `parentUuid` is `null` because of a compaction.
   */
  readonly logicalParentUuid?: unknown;
  readonly compactMetadata?: unknown;
  readonly isSidechain?: unknown;
  readonly sessionId?: unknown;
  readonly message?: unknown;
}

/** Safety cap when walking up the parent chain: a corrupt transcript must not hang the turn. */
const MAX_ANCESTRY_DEPTH = 10_000;

async function transcriptFiles(directory: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
}

/** Reads the JSONL transcript file, splitting out the new entries past the given offset. */
async function readTranscriptSince(
  file: string,
  offset: number,
): Promise<TranscriptSlice<TranscriptEntry>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { entries: [], appended: [] };
  }
  const entries: TranscriptEntry[] = [];
  const appended: TranscriptEntry[] = [];
  let position = 0;
  for (const line of raw.split(/\r?\n/u)) {
    const start = position;
    position += Buffer.byteLength(line, "utf8") + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const entry = value as TranscriptEntry;
        entries.push(entry);
        if (start >= offset) appended.push(entry);
      }
    } catch {
      // Half-written line: the TUI is still flushing it.
    }
  }
  return { entries, appended };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extracts the text of a user entry from the transcript. */
function userText(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part): part is { type?: unknown; text?: unknown } =>
        typeof part === "object" && part !== null)
      .filter((part) => part.type === "text")
      .map((part) => asString(part.text) ?? "");
    const joined = parts.join("");
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/** The visible text of an assistant entry. */
function assistantText(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((part): part is { type?: unknown; text?: unknown } =>
      typeof part === "object" && part !== null)
    .filter((part) => part.type === "text")
    .map((part) => asString(part.text) ?? "");
  const joined = parts.join("");
  return joined.length > 0 ? joined : undefined;
}

function stopReason(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  return asString((message as { stop_reason?: unknown }).stop_reason);
}

/** Locates the user entry in the transcript whose text exactly matches the prompt. */
function findInjectedTurn(
  entries: readonly TranscriptEntry[],
  promptText: string,
): { readonly uuid: string; readonly sessionId?: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "user" || entry.isSidechain === true) continue;
    if (userText(entry) !== promptText) continue;
    const uuid = asString(entry.uuid);
    if (uuid === undefined) continue;
    const sessionId = asString(entry.sessionId);
    return sessionId === undefined ? { uuid } : { uuid, sessionId };
  }
  return undefined;
}

/** Checks whether an assistant entry descends genealogically from the user's UUID. */
export function descendsFrom(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  entry: TranscriptEntry,
  ancestorUuid: string,
  positions?: ReadonlyMap<string, number>,
): boolean {
  const seen = new Set<string>();
// If the walk crosses a compaction, its position is remembered: it's the bridge that lets us
    // decide by position when claude leaves the logical chain broken. See `crossedCompaction` below.
  let compactionAt: number | undefined;
  let current: string | undefined = parentOf(entry);
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== undefined; depth += 1) {
    if (current === ancestorUuid) return true;
    if (seen.has(current)) return crossedCompaction(positions, compactionAt, ancestorUuid);
    seen.add(current);
    const parent: TranscriptEntry | undefined = byUuid.get(current);
    if (parent === undefined) return crossedCompaction(positions, compactionAt, ancestorUuid);
    if (parent.type === "system" && parent.subtype === "compact_boundary") {
      const at = positions?.get(current);
      if (at !== undefined && (compactionAt === undefined || at < compactionAt)) compactionAt = at;
    }
    current = parentOf(parent);
  }
  return crossedCompaction(positions, compactionAt, ancestorUuid);
}

/**
 * Checks whether the ancestor precedes a compaction boundary in the transcript.
 */
function crossedCompaction(
  positions: ReadonlyMap<string, number> | undefined,
  compactionAt: number | undefined,
  ancestorUuid: string,
): boolean {
  if (positions === undefined || compactionAt === undefined) return false;
  const ancestorAt = positions.get(ancestorUuid);
  return ancestorAt !== undefined && ancestorAt < compactionAt;
}

/**
 * Position of the first occurrence of each uuid in the transcript.
 */
function positionByUuid(
  entries: readonly TranscriptEntry[],
): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const uuid = asString(entries[index]?.uuid);
    if (uuid !== undefined && !positions.has(uuid)) positions.set(uuid, index);
  }
  return positions;
}

/**
 * Gets the parent UUID of an entry, using logicalParentUuid if parentUuid is null.
 */
function parentOf(entry: TranscriptEntry): string | undefined {
  return asString(entry.parentUuid) ?? asString(entry.logicalParentUuid);
}

interface CompactionEvent {
  readonly uuid: string;
  /** `auto` (automatic) or `manual` (`/compact`). */
  readonly trigger: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
}

/**
 * Extracts compaction events among the given entries.
 */
function compactBoundaries(
  entries: readonly TranscriptEntry[],
): readonly CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
    const uuid = asString(entry.uuid);
    if (uuid === undefined) continue;
    const metadata = typeof entry.compactMetadata === "object" && entry.compactMetadata !== null
      ? entry.compactMetadata as Record<string, unknown>
      : {};
    const pre = typeof metadata.preTokens === "number" ? metadata.preTokens : undefined;
    const post = typeof metadata.postTokens === "number" ? metadata.postTokens : undefined;
    events.push({
      uuid,
      trigger: asString(metadata.trigger) ?? "desconocido",
      ...(pre === undefined ? {} : { preTokens: pre }),
      ...(post === undefined ? {} : { postTokens: post }),
    });
  }
  return events;
}

/**
 * Index by uuid keeping only the first occurrence of each one.
 */
export function indexByUuid(
  entries: readonly TranscriptEntry[],
): ReadonlyMap<string, TranscriptEntry> {
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    const uuid = asString(entry.uuid);
    if (uuid !== undefined && !byUuid.has(uuid)) byUuid.set(uuid, entry);
  }
  return byUuid;
}

/**
 * The final answer of the turn we injected.
 */
export function findFinalAssistant(
  entries: readonly TranscriptEntry[],
  userUuid: string,
): { readonly text: string; readonly sessionId?: string } | undefined {
  const byUuid = indexByUuid(entries);
  const positions = positionByUuid(entries);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (stopReason(entry) !== "end_turn") continue;
    if (!descendsFrom(byUuid, entry, userUuid, positions)) continue;
    const text = assistantText(entry);
    if (text === undefined) continue;
    const sessionId = asString(entry.sessionId);
    return sessionId === undefined ? { text } : { text, sessionId };
  }
  return undefined;
}

/**
 * Searches the assistant responses in the transcript for a correlated structured envelope.
 */
export function findEnvelopeTurn(
  entries: readonly TranscriptEntry[],
  correlationId: string,
  desde?: string,
): { readonly text: string; readonly sessionId?: string } | undefined {
  const floor = desde === undefined ? 0 : (positionByUuid(entries).get(desde) ?? 0);
  for (let index = entries.length - 1; index >= floor; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (stopReason(entry) !== "end_turn") continue;
    const text = assistantText(entry);
    if (text === undefined || !envelopeHasCorrelation(text, correlationId)) continue;
    const sessionId = asString(entry.sessionId);
    const body = stripJsonFence(text);
    return sessionId === undefined ? { text: body } : { text: body, sessionId };
  }
  return undefined;
}

/**
 * Creates a `TranscriptReader` for processing Claude JSONL transcripts.
 */
export function claudeTranscript(
  configDirectory: string,
  workspace: string,
): TranscriptReader<TranscriptEntry> {
  const directory = transcriptDirectoryIn(configDirectory, workspace);
  return {
    files: () => transcriptFiles(directory),
    read: (file, offset) => readTranscriptSince(file, offset),
    findInjected: (_file, entries, promptText) => {
      const found = findInjectedTurn(entries, promptText);
      if (found === undefined) return undefined;
      return found.sessionId === undefined
        ? { key: found.uuid }
        : { key: found.uuid, sessionId: found.sessionId };
    },
    findAnswer: (entries, key) => {
      const answer = findFinalAssistant(entries, key);
      if (answer === undefined) return undefined;
      const text = stripJsonFence(answer.text);
      return answer.sessionId === undefined
        ? { kind: "answer", text }
        : { kind: "answer", text, sessionId: answer.sessionId };
    },
    findEnvelope: (entries, correlationId, desde) => {
      const found = findEnvelopeTurn(entries, correlationId, desde);
      if (found === undefined) return undefined;
      return found.sessionId === undefined
        ? { kind: "answer", text: found.text }
        : { kind: "answer", text: found.text, sessionId: found.sessionId };
    },
    compactions: (appended) => compactBoundaries(appended).map((event) => {
      const tokens = event.preTokens === undefined || event.postTokens === undefined
        ? ""
        : ` (${String(event.preTokens)} -> ${String(event.postTokens)} tokens)`;
      return {
        id: event.uuid,
        detail: `la terminal compactó su contexto durante este turno, disparo ${event.trigger}`
          + tokens,
      };
    }),
    stdout: (text, sessionId) => JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    }),
  };
}

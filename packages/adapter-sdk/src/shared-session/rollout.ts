import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { envelopeHasCorrelation } from "./envelope.js";
import type {
  CompactionNotice,
  InjectedTurn,
  TranscriptReader,
  TranscriptSlice,
  TurnOutcome,
} from "./types.js";

/**
 * Reader and analyzer for rollout-style transcripts produced by Codex.
 */

/** One line of the rollout, already decoded. */
export interface RolloutLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

/** Root directory where Codex stores session rollouts. */
export function rolloutDirectory(codexHome: string): string {
  return join(codexHome.replace(/\/+$/u, ""), "sessions");
}

/** Extracts the session ID from the rollout filename. */
export function rolloutSessionId(file: string): string | undefined {
  const found = /-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/u.exec(file);
  return found?.[1];
}

/** Rollouts in the tree, recursive. A missing tree is an empty list, not a failure. */
async function rolloutFiles(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** Reads JSON entries from the rollout starting at the given offset. */
async function readRolloutSince(
  file: string,
  offset: number,
): Promise<TranscriptSlice<RolloutLine>> {
  let raw: string;
  try {
    const chunks: string[] = [];
    const stream = createReadStream(file, { start: Math.max(offset, 0), encoding: "utf8" });
    for await (const chunk of stream) chunks.push(String(chunk));
    raw = chunks.join("");
  } catch {
    return { entries: [], appended: [] };
  }
  const lines = raw.split("\n");
  // If the file ends with a newline, the last chunk is "" and nothing is lost; otherwise it's a
  // half-written line. In both cases it is discarded.
  lines.pop();
  const entries: RolloutLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        entries.push(value);
      }
    } catch {
// A cut mid-multibyte-character on the first byte read, or a half-written line: on the next
        // poll it is read again from the same place.
    }
  }
  return { entries, appended: entries };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Payload of an `event_msg`, where codex records what happens in the turn. */
function eventPayload(line: RolloutLine | undefined): Record<string, unknown> | undefined {
  return line?.type === "event_msg" ? asObject(line.payload) : undefined;
}

/** Payload of a message with a specific role inside a `response_item`. */
function messagePayload(
  line: RolloutLine | undefined,
  role: string,
): Record<string, unknown> | undefined {
  if (line?.type !== "response_item") return undefined;
  const payload = asObject(line.payload);
  if (payload?.type !== "message" || payload.role !== role) return undefined;
  return payload;
}

/**
 * The text of a message, as written.
 *
 * Text pieces are joined and everything else (images, references) is ignored. The bus's prompt
 * is text and only text, so exact equality against what was pasted stays solid.
 */
function messageText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => asObject(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => part.type === "input_text" || part.type === "output_text" || part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""));
  const joined = parts.join("");
  return joined.length > 0 ? joined : undefined;
}

/** The `turn_id` hanging off a message's metadata. */
function messageTurnId(payload: Record<string, unknown>): string | undefined {
  const metadata = asObject(payload.internal_chat_message_metadata_passthrough);
  const turnId = metadata?.turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Normalizes text by trimming trailing whitespace or newlines for exact comparisons.
 */
function submitted(text: string | undefined): string | undefined {
  return text?.replace(/\s+$/u, "");
}

/**
 * The user entry that created this bus turn, and the `turn_id` to track it with.
 */
function findInjectedRolloutTurn(
  file: string,
  entries: readonly RolloutLine[],
  promptText: string,
): InjectedTurn | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = messagePayload(entries[index], "user");
    if (payload === undefined) continue;
    if (submitted(messageText(payload)) !== submitted(promptText)) continue;
    const key = messageTurnId(payload);
    if (key === undefined) continue;
    const sessionId = rolloutSessionId(file);
    return sessionId === undefined ? { key } : { key, sessionId };
  }
  return undefined;
}

/**
 * Identifies the turn's outcome in the rollout from its turn_id.
 */
function findRolloutOutcome(
  entries: readonly RolloutLine[],
  key: string,
): TurnOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = eventPayload(entries[index]);
    if (payload?.turn_id !== key) continue;
    if (payload.type === "task_complete") {
      const text = asText(payload.last_agent_message) ?? finalAnswerOf(entries, key);
      return text === undefined
        ? { kind: "failed", detail: "el turno terminó en la terminal sin ningún mensaje del agente" }
        : { kind: "answer", text };
    }
    if (payload.type === "turn_aborted") {
      const reason = asText(payload.reason) ?? "sin motivo declarado";
      return {
        kind: "failed",
        detail: `el turno se interrumpió dentro de la terminal antes de responder (${reason})`,
      };
    }
  }
  return undefined;
}

/**
 * Searches the rollout's task_complete events for a correlated structured envelope.
 */
function findRolloutEnvelope(
  entries: readonly RolloutLine[],
  correlationId: string,
): TurnOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = eventPayload(entries[index]);
    if (payload?.type !== "task_complete") continue;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    const text = asText(payload.last_agent_message)
      ?? (turnId === undefined ? undefined : finalAnswerOf(entries, turnId));
    if (text === undefined || !envelopeHasCorrelation(text, correlationId)) continue;
    return { kind: "answer", text };
  }
  return undefined;
}

/** The assistant's last final message for that turn. Backup if the close comes without text. */
function finalAnswerOf(entries: readonly RolloutLine[], key: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = messagePayload(entries[index], "assistant");
    if (payload?.phase !== "final_answer") continue;
    if (messageTurnId(payload) !== key) continue;
    const text = messageText(payload);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Compactions that occurred in the new entries.
 */
function rolloutCompactions(appended: readonly RolloutLine[]): readonly CompactionNotice[] {
  const events: CompactionNotice[] = [];
  for (const [index, line] of appended.entries()) {
    if (eventPayload(line)?.type !== "context_compacted") continue;
    const stamp = typeof line.timestamp === "string" ? line.timestamp : String(index);
    events.push({
      id: stamp,
      detail: `la terminal compactó su contexto durante este turno (${stamp})`,
    });
  }
  return events;
}

/**
 * Creates a `TranscriptReader` for processing Codex rollouts.
 */
export function codexTranscript(codexHome: string): TranscriptReader<RolloutLine> {
  const directory = rolloutDirectory(codexHome);
  return {
    files: () => rolloutFiles(directory),
    read: (file, offset) => readRolloutSince(file, offset),
    findInjected: findInjectedRolloutTurn,
    findAnswer: findRolloutOutcome,
    findEnvelope: (entries, correlationId) => findRolloutEnvelope(entries, correlationId),
    compactions: rolloutCompactions,
    // `task_started` is the first line of any turn, whether it comes from the bus or the owner.
    // None new proves the injection never reached the box and NOTHING ran.
    startedTurn: (appended) => appended.some((line) => eventPayload(line)?.type === "task_started"),
    stdout: (text, sessionId) => [
      ...(sessionId === undefined
        ? []
        : [JSON.stringify({ type: "thread.started", thread_id: sessionId })]),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    ].join("\n"),
  };
}

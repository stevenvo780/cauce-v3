import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { envelopeHasCorrelation, stripJsonFence } from "./envelope.js";
import { transcriptDirectoryIn } from "./session.js";
import type { TranscriptReader, TranscriptSlice } from "./types.js";

export { stripJsonFence } from "./envelope.js";

/**
 * Lector y analizador de transcripts JSONL generados por Claude.
 */

export interface TranscriptEntry {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly uuid?: unknown;
  readonly parentUuid?: unknown;
  /**
   * El padre real cuando `parentUuid` es `null` por una compactación.
   */
  readonly logicalParentUuid?: unknown;
  readonly compactMetadata?: unknown;
  readonly isSidechain?: unknown;
  readonly sessionId?: unknown;
  readonly message?: unknown;
}

/** Cota de seguridad al subir la cadena de padres: un transcript corrupto no puede colgar el turno. */
const MAX_ANCESTRY_DEPTH = 10_000;

export async function transcriptFiles(directory: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
}

/** Lee el archivo de transcript JSONL separando las entradas nuevas posteriores al offset indicado. */
export async function readTranscriptSince(
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
      // Línea a medio escribir: la TUI todavía la está volcando.
    }
  }
  return { entries, appended };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extrae el texto de una entrada de usuario del transcript. */
export function userText(entry: TranscriptEntry): string | undefined {
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

/** El texto visible de una entrada del asistente. */
export function assistantText(entry: TranscriptEntry): string | undefined {
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

/** Localiza la entrada de usuario en el transcript cuyo texto coincide exactamente con el prompt. */
export function findInjectedTurn(
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

/** Comprueba si una entrada de asistente desciende genealógicamente del UUID del usuario. */
export function descendsFrom(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  entry: TranscriptEntry,
  ancestorUuid: string,
  positions?: ReadonlyMap<string, number>,
): boolean {
  const seen = new Set<string>();
  // Si la subida cruza una compactación, se recuerda DÓNDE: es el puente que permite decidir por
  // posición cuando claude deja la cadena lógica rota. Ver `crossedCompaction` más abajo.
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
 * Comprueba si el ancestro precede a una frontera de compactación en el transcript.
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
 * Posición de la primera aparición de cada uuid en el transcript.
 */
export function positionByUuid(
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
 * Obtiene el UUID padre de una entrada, usando logicalParentUuid si parentUuid es nulo.
 */
function parentOf(entry: TranscriptEntry): string | undefined {
  return asString(entry.parentUuid) ?? asString(entry.logicalParentUuid);
}

export interface CompactionEvent {
  readonly uuid: string;
  /** `auto` (automático) o `manual` (`/compact`). */
  readonly trigger: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
}

/**
 * Extrae eventos de compactación entre las entradas provistas.
 */
export function compactBoundaries(
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
 * Índice por uuid quedándose con la primera aparición de cada uno.
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
 * La respuesta final del turno que inyectamos.
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
 * Busca un sobre estructurado correlacionado en las respuestas del asistente del transcript.
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
 * Crea un `TranscriptReader` para procesar transcripts JSONL de Claude.
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
        : ` (${event.preTokens} -> ${event.postTokens} tokens)`;
      return {
        id: event.uuid,
        detail: `la terminal compactó su contexto durante este turno, disparo ${event.trigger}`
          + `${tokens}`,
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

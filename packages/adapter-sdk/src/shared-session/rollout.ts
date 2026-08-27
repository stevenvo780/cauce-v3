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
 * Lector y analizador de transcripts tipo rollout generados por Codex.
 */

/** Una línea del rollout, ya decodificada. */
export interface RolloutLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

/** Directorio raíz donde Codex almacena los rollouts de sesiones. */
export function rolloutDirectory(codexHome: string): string {
  return join(codexHome.replace(/\/+$/u, ""), "sessions");
}

/** Extrae el ID de sesión del nombre del archivo de rollout. */
export function rolloutSessionId(file: string): string | undefined {
  const found = /-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/u.exec(file);
  return found?.[1];
}

/** Los rollouts del árbol, recursivo. Un árbol ausente es una lista vacía, no un fallo. */
export async function rolloutFiles(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** Lee entradas JSON del rollout a partir del offset indicado. */
export async function readRolloutSince(
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
  // Si el fichero termina en salto, el último trozo es "" y no se pierde nada; si no, es una línea
  // a medio escribir. En los dos casos se descarta.
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
      // Un corte a mitad de un carácter multibyte en el primer byte leído, o una línea a medio
      // escribir: en el siguiente sondeo se lee otra vez desde el mismo sitio.
    }
  }
  return { entries, appended: entries };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** El payload de un `event_msg`, que es donde codex cuenta lo que le pasa al turno. */
function eventPayload(line: RolloutLine | undefined): Record<string, unknown> | undefined {
  return line?.type === "event_msg" ? asObject(line.payload) : undefined;
}

/** El payload de un mensaje de un rol concreto dentro de un `response_item`. */
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
 * El texto de un mensaje, tal como quedó escrito.
 *
 * Se juntan los trozos de texto y se ignora todo lo demás (imágenes, referencias). El pedido del
 * bus es texto y sólo texto, así que la igualdad exacta contra lo que se pegó sigue siendo sólida.
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

/** El `turn_id` que cuelga de los metadatos de un mensaje. */
function messageTurnId(payload: Record<string, unknown>): string | undefined {
  const metadata = asObject(payload.internal_chat_message_metadata_passthrough);
  const turnId = metadata?.turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Normaliza el texto recortando espacios o saltos de línea finales para comparaciones exactas.
 */
function submitted(text: string | undefined): string | undefined {
  return text?.replace(/\s+$/u, "");
}

/**
 * La entrada de usuario que creó este turno del bus, y el `turn_id` con el que seguirlo.
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
 * Identifica el desenlace del turno en el rollout a partir de su turn_id.
 */
function findRolloutOutcome(
  entries: readonly RolloutLine[],
  key: string,
): TurnOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = eventPayload(entries[index]);
    if (payload === undefined || payload.turn_id !== key) continue;
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
 * Busca un sobre estructurado correlacionado en los eventos task_complete del rollout.
 */
function findRolloutEnvelope(
  entries: readonly RolloutLine[],
  correlationId: string,
): TurnOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = eventPayload(entries[index]);
    if (payload === undefined || payload.type !== "task_complete") continue;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    const text = asText(payload.last_agent_message)
      ?? (turnId === undefined ? undefined : finalAnswerOf(entries, turnId));
    if (!envelopeHasCorrelation(text, correlationId)) continue;
    return { kind: "answer", text: text! };
  }
  return undefined;
}

/** El último mensaje final del asistente de ese turno. Respaldo por si el cierre viene sin texto. */
function finalAnswerOf(entries: readonly RolloutLine[], key: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = messagePayload(entries[index], "assistant");
    if (payload === undefined || payload.phase !== "final_answer") continue;
    if (messageTurnId(payload) !== key) continue;
    const text = messageText(payload);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Las compactaciones ocurridas en lo nuevo.
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
 * Crea un `TranscriptReader` para procesar rollouts de Codex.
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
    // `task_started` es la primera línea de cualquier turno, venga del bus o del dueño. Que no haya
    // ninguna nueva prueba que la inyección no llegó a la caja y que NADA corrió.
    startedTurn: (appended) => appended.some((line) => eventPayload(line)?.type === "task_started"),
    stdout: (text, sessionId) => [
      ...(sessionId === undefined
        ? []
        : [JSON.stringify({ type: "thread.started", thread_id: sessionId })]),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    ].join("\n"),
  };
}

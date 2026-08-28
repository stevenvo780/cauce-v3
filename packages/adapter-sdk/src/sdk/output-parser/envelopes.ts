import { MalformedOutputError } from "../errors.js";
import type { ParsedHarnessOutput, StructuredOutput } from "../types.js";
import {
  LEADING_INVISIBLE_TEXT,
  MAX_EMBEDDED_ENVELOPE_CANDIDATES,
  MAX_FINAL_TEXT_BYTES,
  REQUIRED_OUTPUT_KEYS,
  hasVisibleText,
  isObject,
  recortarABytes,
  type JsonObject,
  validateStructuredOutput,
} from "./contract.js";

/**
 * Native failure statuses reported by the different harness dialects.
 */
const NATIVE_FAILURE_STATUS: ReadonlySet<string> = new Set([
  "error",
  "errored",
  "failed",
  "failure",
  "fatal",
  "aborted",
  "cancelled",
  "canceled",
  "timeout",
  "timed_out",
  "interrupted",
  "rejected",
]);
const FAILURE_DETAIL_KEYS = ["message", "detail", "description", "reason", "error", "text"] as const;
const MAX_FAILURE_DETAIL_BYTES = 4 * 1024;

export function failureText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return hasVisibleText(value) ? value.trim() : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = failureText(entry, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const key of FAILURE_DETAIL_KEYS) {
      const nested = failureText(value[key], depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function hasErrorPayload(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return hasVisibleText(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Failure signal in a native wrapper object. The contract envelope is EXPLICITLY left out: its
 * `status:"failed"` is already validated by `validateStructuredOutput`, and confusing it with a
 * native `status` would let it through the mill twice.
 */
export function nativeFailureDetail(value: JsonObject): string | undefined {
  if (isEnvelopeShape(value)) return undefined;
  const declared = failureText(value.error) ?? failureText(value.message);
  if (value.ok === false || value.success === false || value.is_error === true || value.isError === true) {
    return declared ?? "the harness reported a failed turn";
  }
  const status = typeof value.status === "string" ? value.status : undefined;
  if (status !== undefined && NATIVE_FAILURE_STATUS.has(status.toLowerCase())) {
    return declared ?? `native status '${status}'`;
  }
  if (hasErrorPayload(value.error)) return declared ?? "the harness reported an error";
  return undefined;
}

/** Claude Code: `is_error` y los `subtype` de la familia `error*` del evento `result`. */
export function claudeFailureDetail(value: JsonObject): string | undefined {
  const subtype = typeof value.subtype === "string" ? value.subtype : undefined;
  const failedSubtype = subtype !== undefined && (subtype === "error" || subtype.startsWith("error_"));
  if (value.is_error === true || failedSubtype) {
    return failureText(value.error)
      ?? failureText(value.message)
      ?? (subtype === undefined ? "is_error" : `result subtype '${subtype}'`);
  }
  return nativeFailureDetail(value);
}

/** Codex `exec --json`: `turn.failed`, `error` y los ítems de tipo `error`. */
export function codexEventFailureDetail(event: JsonObject): string | undefined {
  if (event.type === "turn.failed") {
    return failureText(event.error) ?? failureText(event.message) ?? "turn.failed";
  }
  if (event.type === "error") {
    return failureText(event.error) ?? failureText(event.message) ?? "error event";
  }
  if (event.type === "item.completed" && isObject(event.item) && event.item.type === "error") {
    return failureText(event.item) ?? "error item";
  }
  return undefined;
}

function safeCandidate(candidate: unknown, context: string): StructuredOutput | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  try {
    return parseCandidate(candidate, context);
  } catch {
    // A turn the harness itself declared failed must not also die on the parser.
    return undefined;
  }
}

function boundedDetail(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_FAILURE_DETAIL_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, MAX_FAILURE_DETAIL_BYTES).toString("utf8")}…`;
}

/**
 * Converts a native failure signal into a real `failed` result.
 */
export function failedTurnOutput(candidate: unknown, context: string, detail: string): StructuredOutput {
  const parsed = safeCandidate(candidate, context);
  if (parsed?.status === "failed") return parsed;
  const spoken = typeof candidate === "string" && hasVisibleText(candidate)
    ? candidate.trim()
    : parsed?.reply ?? undefined;
  const headline = `${context} reported a failed turn: ${detail}`;
  return {
    reply: boundedDetail(spoken === undefined ? headline : `${headline}\n\n${spoken}`),
    messages: [],
    notify: [],
    status: "failed",
    retryable: false,
    artifacts: [],
  };
}

export function sessionResult(output: StructuredOutput, nativeSessionId: unknown): ParsedHarnessOutput {
  if (typeof nativeSessionId === "string" && nativeSessionId.length > 0) {
    return { output, nativeSessionId };
  }
  return { output };
}

export function structuredCandidate(value: unknown): unknown {
  if (isObject(value) && "output" in value) return value.output;
  return value;
}

function fallbackTextOutput(text: string, context: string): StructuredOutput {
  const reply = text.trim();
  if (!hasVisibleText(reply)) throw new MalformedOutputError(`${context} did not contain visible text`);
  if (Buffer.byteLength(reply, "utf8") > MAX_FINAL_TEXT_BYTES) {
    throw new MalformedOutputError(`${context} exceeded the plain-text reply limit`);
  }
  return {
    reply,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
}

/**
 * Trims top-level JSON objects embedded in text.
 */
function embeddedObjects(text: string): readonly string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1));
        start = -1;
        if (found.length >= MAX_EMBEDDED_ENVELOPE_CANDIDATES) break;
      }
    }
  }
  return found;
}

function isEnvelopeShape(value: unknown): boolean {
  return isObject(value) && REQUIRED_OUTPUT_KEYS.every((key) => key in value);
}

/**
 * Recovers a structured-output envelope embedded in plain text.
 */
function recoverEmbeddedEnvelope(
  text: string,
  context: string,
  rejectAmbiguous = true,
): StructuredOutput | undefined {
  const candidates = embeddedObjects(text);
  if (candidates.length === 0) return undefined;

  const envelopes: JsonObject[] = [];
  for (const candidate of candidates) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    if (isObject(decoded) && isEnvelopeShape(decoded)) envelopes.push(decoded);
  }

  if (envelopes.length === 0) return undefined;
  if (envelopes.length > 1) {
    if (!rejectAmbiguous) return undefined;
    throw new MalformedOutputError(
      `${context} embedded more than one structured output envelope in plain text; refusing to guess which delegation is real`,
    );
  }
  return validateStructuredOutput(envelopes[0]);
}

function recoverOrFallback(text: string, context: string): StructuredOutput {
  const recovered = recoverEmbeddedEnvelope(text, context);
  if (recovered !== undefined) return recovered;
  const fenced = fencedObjectCandidate(text);
  return fenced === undefined
    ? fallbackTextOutput(text, context)
    : recoverMalformedObject(fenced, context);
}

/**
 * Unwraps markdown code blocks (```json ... ```) if they contain a JSON object.
 */
const CODE_FENCE = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/u;
const EMBEDDED_CODE_FENCE = /```[A-Za-z0-9_-]*[\t ]*\r?\n/gu;

function unwrapCodeFence(candidate: string): string {
  const match = CODE_FENCE.exec(candidate);
  if (match === null) return candidate;
  const inner = (match[1] ?? "").trim();
  return inner.startsWith("{") || inner.startsWith("[") ? inner : candidate;
}

/** Locates a JSON object candidate that begins after a code fence. */
function fencedObjectCandidate(text: string): string | undefined {
  EMBEDDED_CODE_FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBEDDED_CODE_FENCE.exec(text)) !== null) {
    const candidate = text.slice(match.index + match[0].length).replace(LEADING_INVISIBLE_TEXT, "");
    if (candidate.startsWith("{")) return candidate;
  }
  return undefined;
}

function previousNonWhitespace(text: string, from: number): string | undefined {
  for (let index = from; index >= 0; index -= 1) {
    const character = text[index];
    if (character !== undefined && !/\s/u.test(character)) return character;
  }
  return undefined;
}

function nextNonWhitespaceIndex(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function stringEnd(text: string, start: number): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return undefined;
}

function isJsonValueStart(character: string | undefined): boolean {
  return character !== undefined
    && (/[0-9]/u.test(character) || ['"', "{", "[", "t", "f", "n", "-"].includes(character));
}

function isRepairableSeparator(character: string | undefined): boolean {
  return character !== undefined && !/[\s{}[\],:"]/u.test(character);
}

function escapeRawStringControls(text: string): { readonly changed: boolean; readonly text: string } {
  let changed = false;
  let escaped = false;
  let inString = false;
  let repaired = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (inString && !escaped && codePoint <= 0x1f) {
      repaired += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      changed = true;
      continue;
    }
    repaired += character;
    if (!inString) {
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
  }
  return { changed, text: repaired };
}

/**
 * Repairs only two deterministic serializer corruptions: raw control characters inside a string,
 * and ONE non-structural character sitting in place of `:` after a key. The scan tracks strings
 * and containers, so it never modifies quoted text inside a `reply`.
 */
function repairJsonEnvelope(candidate: string): string | undefined {
  const escapedControls = escapeRawStringControls(candidate);
  const text = escapedControls.text;
  const stack: ("array" | "object")[] = [];
  const separatorIndexes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      const end = stringEnd(text, start);
      if (end === undefined) break;
      const isObjectKey = stack.at(-1) === "object"
        && ["{", ","].includes(previousNonWhitespace(text, start - 1) ?? "");
      if (isObjectKey) {
        const separator = nextNonWhitespaceIndex(text, end + 1);
        if (text[separator] !== ":") {
          const value = nextNonWhitespaceIndex(text, separator + 1);
          if (isRepairableSeparator(text[separator]) && isJsonValueStart(text[value])) {
            separatorIndexes.push(separator);
          }
        }
      }
      index = end;
      continue;
    }
    if (character === "{") stack.push("object");
    else if (character === "[") stack.push("array");
    else if (character === "}" && stack.at(-1) === "object") stack.pop();
    else if (character === "]" && stack.at(-1) === "array") stack.pop();
  }

  // Two corrupt separators are no longer an unambiguous patch: fall back to rescue without effect.
  if (separatorIndexes.length > 1) return undefined;
  if (!escapedControls.changed && separatorIndexes.length === 0) return undefined;
  if (separatorIndexes.length === 0) return text;
  const separator = separatorIndexes[0];
  if (separator === undefined) return undefined;
  return `${text.slice(0, separator)}:${text.slice(separator + 1)}`;
}

function repairedEnvelope(candidate: string): StructuredOutput | undefined {
  const repaired = repairJsonEnvelope(candidate);
  if (repaired === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(repaired) as unknown;
  } catch {
    return undefined;
  }
  if (!isEnvelopeShape(decoded)) return undefined;
  try {
    return validateStructuredOutput(decoded);
  } catch {
    // An accessory that doesn't revalidate is not materialized. The reply may still be rescued below.
    return undefined;
  }
}

/**
 * Rescues the `reply` field from a truncated JSON envelope to preserve the generated answer.
 */
interface RecoveredReplyString {
  readonly end?: number;
  readonly value: string;
}

function decodeRecoveredReply(encoded: string): string | undefined {
  try {
    const value = JSON.parse(`"${encoded}"`) as unknown;
    return typeof value === "string" && hasVisibleText(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function recoverReplyString(candidate: string, start: number): RecoveredReplyString | undefined {
  let encoded = "";
  for (let index = start + 1; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === '"') {
      const next = nextNonWhitespaceIndex(candidate, index + 1);
      if (next < candidate.length && candidate[next] !== "," && candidate[next] !== "}") {
        return undefined;
      }
      const value = decodeRecoveredReply(encoded);
      return value === undefined ? undefined : { end: index, value };
    }
    if (character === "\\") {
      const escaped = candidate[index + 1];
      if (escaped === undefined) break;
      if (escaped === "u") {
        const digits = candidate.slice(index + 2, index + 6);
        if (digits.length === 4 && /^[0-9a-f]{4}$/iu.test(digits)) {
          encoded += `\\u${digits}`;
          index += 5;
          continue;
        }
        const tail = candidate.slice(index + 2);
        if (tail.length < 4 && /^[0-9a-f]*$/iu.test(tail)) break;
        return undefined;
      }
      if (!/["\\/bfnrt]/u.test(escaped)) return undefined;
      encoded += `\\${escaped}`;
      index += 1;
      continue;
    }
    const codePoint = character?.codePointAt(0) ?? 0;
    encoded += codePoint <= 0x1f
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }

  // The transport truncated the string: only the prefix that can be unescaped is preserved.
  const value = decodeRecoveredReply(encoded);
  return value === undefined ? undefined : { value };
}

function replyValueStart(candidate: string, keyEnd: number): number | undefined {
  const separator = nextNonWhitespaceIndex(candidate, keyEnd + 1);
  if (candidate[separator] === ":") return nextNonWhitespaceIndex(candidate, separator + 1);
  if (!isRepairableSeparator(candidate[separator])) return undefined;
  const value = nextNonWhitespaceIndex(candidate, separator + 1);
  return candidate[value] === '"' ? value : undefined;
}

function rescataReply(candidate: string): string | undefined {
  const outerStart = nextNonWhitespaceIndex(candidate, 0);
  if (candidate[outerStart] !== "{") return undefined;

  const stack: ("array" | "object")[] = [];
  let recovered: string | undefined;
  for (let index = outerStart; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === '"') {
      const start = index;
      const end = stringEnd(candidate, start);
      if (end === undefined) break;
      const topLevelKey = stack.length === 1 && stack[0] === "object"
        && ["{", ","].includes(previousNonWhitespace(candidate, start - 1) ?? "");
      if (topLevelKey && candidate.slice(start + 1, end) === "reply") {
        // Two reply keys in the same envelope are ambiguous. JSON.parse would pick the last, but on an
        // already-broken envelope none is materialized by intuition.
        if (recovered !== undefined) return undefined;
        const valueStart = replyValueStart(candidate, end);
        if (valueStart === undefined || candidate[valueStart] !== '"') return undefined;
        const reply = recoverReplyString(candidate, valueStart);
        if (reply === undefined) return undefined;
        recovered = reply.value;
        if (reply.end === undefined) break;
        index = reply.end;
        continue;
      }
      index = end;
      continue;
    }
    if (character === "{") stack.push("object");
    else if (character === "[") stack.push("array");
    else if (character === "}" && stack.at(-1) === "object") {
      stack.pop();
      if (stack.length === 0) break;
    } else if (character === "]" && stack.at(-1) === "array") {
      stack.pop();
    }
  }
  return recovered;
}

function malformedObjectOutput(candidate: string, context: string): StructuredOutput {
  const sample = recortarABytes(candidate.trim(), 512);
  return {
    reply: `No pude reconstruir la salida de ${context}: el sobre JSON quedo roto y no quedo ni una linea de texto rescatable. Se descartaron delegaciones y campos accesorios porque no se pueden validar con seguridad.\n\n[Cauce] Empieza asi: ${sample}`,
    messages: [],
    notify: [],
    status: "failed",
    retryable: false,
    artifacts: [],
  };
}

function recoverMalformedObject(candidate: string, context: string): StructuredOutput {
  // If there's a single complete envelope with prose or garbage after, all its fields are kept.
  // Two glued envelopes are ambiguous: no delegation is chosen and the reply is fallen back to.
  const embedded = recoverEmbeddedEnvelope(candidate, context, false);
  if (embedded !== undefined) return embedded;
  const repaired = repairedEnvelope(candidate);
  if (repaired !== undefined) return repaired;
  const reply = rescataReply(candidate);
  return reply === undefined
    ? malformedObjectOutput(candidate, context)
    : fallbackTextOutput(reply, context);
}

export function parseFinalText(text: string, context: string): StructuredOutput {
  const trimmed = text.trim();
  if (!hasVisibleText(trimmed)) throw new MalformedOutputError(`${context} did not contain visible text`);
  const jsonCandidate = unwrapCodeFence(trimmed.replace(LEADING_INVISIBLE_TEXT, ""));

  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonCandidate) as unknown;
  } catch {
    if (jsonCandidate.startsWith("{")) {
      return recoverMalformedObject(jsonCandidate, context);
    }
    return recoverOrFallback(trimmed, context);
  }

  if (isObject(decoded)) return validateStructuredOutput(decoded);
  if (typeof decoded === "string") return recoverOrFallback(decoded, context);
  throw new MalformedOutputError(`${context} must be a structured JSON object or non-empty text`);
}

export function parseCandidate(candidate: unknown, context: string): StructuredOutput {
  return typeof candidate === "string"
    ? parseFinalText(candidate, context)
    : validateStructuredOutput(candidate);
}

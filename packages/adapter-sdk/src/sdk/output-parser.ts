import { AdapterError, MalformedOutputError } from "./errors.js";
import type {
  NotifyDirective,
  NotifyKind,
  OutputArtifact,
  ParsedHarnessOutput,
  RelayMessage,
  StructuredOutput,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export interface DeliveryOutputContractContext {
  readonly messageType?: string;
  readonly senderAlias?: string;
  readonly selfAlias?: string;
  readonly routingTargets?: readonly DeliveryRoutingTarget[];
}

export interface DeliveryRoutingTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly online: boolean;
}

/** Keep plain-text compatibility bounded below the process runner's 2 MiB cap. */
export const MAX_FINAL_TEXT_BYTES = 64 * 1024;
export const MAX_RELAY_BODY_BYTES = 64 * 1024;
export const MAX_RELAY_AGGREGATE_BYTES = 256 * 1024;
export const MAX_EXPANDED_RELAY_AGGREGATE_BYTES = 512 * 1024;
export const MAX_RELAY_MESSAGES = 100;
/** Proactive egress reaches a human, so its limits are an order of magnitude tighter. */
export const MAX_NOTIFY_DIRECTIVES = 4;
export const MAX_NOTIFY_BODY_BYTES = 4 * 1024;
export const MAX_NOTIFY_AGGREGATE_BYTES = 8 * 1024;
export const NOTIFY_KINDS: readonly NotifyKind[] = [
  "task_complete",
  "decision_request",
  "digest",
  "alert",
];
const MAX_OPENCLAW_UNWRAP_DEPTH = 8;
const CANONICAL_MESSAGE_TARGET = /^(?:@all|[a-z][a-z0-9_-]{0,63})$/u;
const CANONICAL_NOTIFY_HANDLE = /^[a-z][a-z0-9_.-]{0,63}$/u;
const INVISIBLE_TEXT = /[\p{White_Space}\p{Cf}\p{Cc}\p{Mn}\p{Me}]/gu;
const LEADING_INVISIBLE_TEXT = /^[\p{White_Space}\p{Cf}\p{Cc}\p{Mn}\p{Me}]+/u;

export function hasVisibleText(value: string): boolean {
  return value.replace(INVISIBLE_TEXT, "").length > 0;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedOutputError(`${context} did not contain valid JSON`);
  }
}

function requiredKeys(value: JsonObject): void {
  for (const key of ["reply", "messages", "status", "retryable", "artifacts"]) {
    if (!(key in value)) {
      throw new MalformedOutputError(`Structured output is missing '${key}'`);
    }
  }
}

function parseMessages(value: unknown): readonly RelayMessage[] {
  if (!Array.isArray(value)) {
    throw new MalformedOutputError("'messages' must be an array");
  }
  if (value.length > MAX_RELAY_MESSAGES) {
    throw new MalformedOutputError(`'messages' exceeded the ${MAX_RELAY_MESSAGES} message limit`);
  }
  let aggregateBodyBytes = 0;
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.to !== "string" || typeof entry.body !== "string") {
      throw new MalformedOutputError(`messages[${index}] must contain string 'to' and 'body'`);
    }
    if (!CANONICAL_MESSAGE_TARGET.test(entry.to)) {
      throw new MalformedOutputError(
        `messages[${index}].to must be a canonical lowercase alias or reserved target`,
      );
    }
    if (!hasVisibleText(entry.body)) {
      throw new MalformedOutputError(`messages[${index}].body must contain visible text`);
    }
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    if (bodyBytes > MAX_RELAY_BODY_BYTES) {
      throw new MalformedOutputError(`messages[${index}].body exceeded the UTF-8 byte limit`);
    }
    aggregateBodyBytes += bodyBytes;
    if (aggregateBodyBytes > MAX_RELAY_AGGREGATE_BYTES) {
      throw new MalformedOutputError("'messages' bodies exceeded the aggregate UTF-8 byte limit");
    }
    return { to: entry.to, body: entry.body };
  });
}

/**
 * `notify` is deliberately absent from requiredKeys(): every live agent emits the
 * five mandatory keys and must keep validating unchanged. An output without it
 * normalizes to an empty list, which produces exactly zero rows downstream.
 */
function parseNotify(value: unknown): readonly NotifyDirective[] {
  if (!Array.isArray(value)) {
    throw new MalformedOutputError("'notify' must be an array");
  }
  if (value.length > MAX_NOTIFY_DIRECTIVES) {
    throw new MalformedOutputError(`'notify' exceeded the ${MAX_NOTIFY_DIRECTIVES} directive limit`);
  }
  let aggregateBodyBytes = 0;
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.to !== "string" || typeof entry.body !== "string") {
      throw new MalformedOutputError(`notify[${index}] must contain string 'to' and 'body'`);
    }
    if (!CANONICAL_NOTIFY_HANDLE.test(entry.to)) {
      throw new MalformedOutputError(`notify[${index}].to must be a canonical destination handle`);
    }
    if (typeof entry.kind !== "string" || !NOTIFY_KINDS.includes(entry.kind as NotifyKind)) {
      throw new MalformedOutputError(
        `notify[${index}].kind must be one of ${NOTIFY_KINDS.join(", ")}`,
      );
    }
    if (!hasVisibleText(entry.body)) {
      throw new MalformedOutputError(`notify[${index}].body must contain visible text`);
    }
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    if (bodyBytes > MAX_NOTIFY_BODY_BYTES) {
      throw new MalformedOutputError(`notify[${index}].body exceeded the UTF-8 byte limit`);
    }
    aggregateBodyBytes += bodyBytes;
    if (aggregateBodyBytes > MAX_NOTIFY_AGGREGATE_BYTES) {
      throw new MalformedOutputError("'notify' bodies exceeded the aggregate UTF-8 byte limit");
    }
    return { to: entry.to, body: entry.body, kind: entry.kind as NotifyKind };
  });
}

function parseArtifacts(value: unknown): readonly OutputArtifact[] {
  if (!Array.isArray(value)) {
    throw new MalformedOutputError("'artifacts' must be an array");
  }
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.uri !== "string") {
      throw new MalformedOutputError(`artifacts[${index}] must contain string 'name' and 'uri'`);
    }
    if (entry.media_type !== undefined && typeof entry.media_type !== "string") {
      throw new MalformedOutputError(`artifacts[${index}].media_type must be a string`);
    }
    if (entry.sha256 !== undefined && typeof entry.sha256 !== "string") {
      throw new MalformedOutputError(`artifacts[${index}].sha256 must be a string`);
    }
    return {
      name: entry.name,
      uri: entry.uri,
      ...(entry.media_type === undefined ? {} : { media_type: entry.media_type }),
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    };
  });
}

export function validateStructuredOutput(value: unknown): StructuredOutput {
  if (!isObject(value)) {
    throw new MalformedOutputError("Structured output must be a JSON object");
  }
  requiredKeys(value);
  if (value.reply !== null && typeof value.reply !== "string") {
    throw new MalformedOutputError("'reply' must be a string or null");
  }
  if (value.status !== "done" && value.status !== "failed") {
    throw new MalformedOutputError("'status' must be 'done' or 'failed'");
  }
  if (typeof value.retryable !== "boolean") {
    throw new MalformedOutputError("'retryable' must be a boolean");
  }
  return {
    reply: value.reply,
    messages: parseMessages(value.messages),
    notify: value.notify === undefined ? [] : parseNotify(value.notify),
    status: value.status,
    // `retryable` has no meaning after a successful terminal result. Native
    // models occasionally emit the redundant contradictory pair
    // `{status:"done", retryable:true}`; canonicalize that one pair without
    // re-executing or weakening validation of the field's type.
    retryable: value.status === "done" ? false : value.retryable,
    artifacts: parseArtifacts(value.artifacts),
  };
}

/**
 * Enforces the semantic result contract once trusted delivery context is
 * available. Dialect parsers intentionally remain context-free; the harness
 * adapter calls this before accepting a parsed result.
 */
export function validateDeliveryOutput(
  output: StructuredOutput,
  context: DeliveryOutputContractContext = {},
): StructuredOutput {
  if (context.messageType === "agent.fanin" && output.messages.length > 0) {
    throw new AdapterError(
      "FANIN_REDELEGATION_FORBIDDEN",
      "An agent.fanin delivery must synthesize the completed aggregate without starting another delegation round",
      false,
    );
  }
  // `notify` is intentionally NOT covered by this rule: telling a human that a
  // long task failed is the single most valuable proactive message there is.
  if (output.status === "failed" && output.messages.length > 0) {
    throw new AdapterError(
      "FAILED_OUTPUT_MESSAGES_FORBIDDEN",
      "A failed harness output cannot delegate messages because failed outputs are not materialized",
      false,
    );
  }

  const internalMessage = context.messageType === "agent.message"
    || context.messageType === "agent.response"
    || context.messageType === "agent.fanin";
  validateDelegationTargets(output.messages, context, internalMessage);

  if (output.reply !== null && !hasVisibleText(output.reply)) {
    throw new AdapterError(
      "INVISIBLE_REPLY",
      "Harness reply must be null or contain visible text",
      false,
    );
  }

  if (output.status !== "done") return output;

  // A notification is a side effect, never the result of the delivery: an agent
  // cannot replace its answer to the caller with a DM to a human.
  if (output.reply === null && output.messages.length === 0) {
    throw new AdapterError(
      "MISSING_FINAL_REPLY",
      "Successful harness output requires a non-empty reply when it does not delegate new work",
      false,
    );
  }

  return output;
}

function validateDelegationTargets(
  messages: readonly RelayMessage[],
  context: DeliveryOutputContractContext,
  internalMessage: boolean,
): void {
  const allMessages = messages.filter((message) => message.to === "@all");
  if (allMessages.length > 0) {
    if (messages.length !== 1) {
      throw new AdapterError(
        "ALL_TARGET_MUST_BE_EXCLUSIVE",
        "The reserved @all target must be the only delegated message",
        false,
      );
    }
    if (internalMessage) {
      throw new AdapterError(
        "INTERNAL_ALL_FORBIDDEN",
        "Internal agent deliveries cannot delegate to @all",
        false,
      );
    }
    if (context.routingTargets === undefined) {
      throw new AdapterError(
        "ROUTING_INVENTORY_UNAVAILABLE",
        "The reserved @all target requires a trusted routing inventory",
        false,
      );
    }
    const onlinePeers = context.routingTargets.filter((target) =>
      target.online && target.alias !== context.selfAlias);
    if (onlinePeers.length === 0) {
      throw new AdapterError(
        "NO_ONLINE_TARGETS",
        "The reserved @all target requires at least one online routable peer",
        false,
      );
    }
    const expandedBytes = Buffer.byteLength(allMessages[0]?.body ?? "", "utf8") * onlinePeers.length;
    if (expandedBytes > MAX_EXPANDED_RELAY_AGGREGATE_BYTES) {
      throw new AdapterError(
        "EXPANDED_RELAY_AGGREGATE_TOO_LARGE",
        "The expanded @all message bodies exceed the relay aggregate byte limit",
        false,
      );
    }
    return;
  }

  if (messages.length > 0 && context.routingTargets === undefined) {
    throw new AdapterError(
      "ROUTING_INVENTORY_UNAVAILABLE",
      "Direct delegation requires a trusted routing inventory",
      false,
    );
  }
  for (const message of messages) {
    if (context.selfAlias !== undefined && message.to === context.selfAlias) {
      throw new AdapterError(
        "DELEGATION_TO_SELF",
        "A harness cannot delegate a message to its own alias",
        false,
      );
    }
    if (context.senderAlias !== undefined && message.to === context.senderAlias) {
      throw new AdapterError(
        "AGENT_MESSAGE_PING_PONG",
        "A harness must return to its sender through reply, never through messages",
        false,
      );
    }

    const matches = context.routingTargets?.filter((target) => target.alias === message.to) ?? [];
    if (matches.length === 0) {
      throw new AdapterError(
        "UNKNOWN_DELEGATION_TARGET",
        "Delegation target is absent from the trusted routing inventory",
        false,
      );
    }
    if (matches.length !== 1) {
      throw new AdapterError(
        "AMBIGUOUS_DELEGATION_TARGET",
        "Delegation alias maps to more than one trusted routing target",
        false,
      );
    }
    if (matches[0]?.online !== true) {
      throw new AdapterError(
        "OFFLINE_DELEGATION_TARGET",
        "Delegation target is not online in the trusted routing inventory",
        false,
      );
    }
  }
}

function sessionResult(output: StructuredOutput, nativeSessionId: unknown): ParsedHarnessOutput {
  if (typeof nativeSessionId === "string" && nativeSessionId.length > 0) {
    return { output, nativeSessionId };
  }
  return { output };
}

function structuredCandidate(value: unknown): unknown {
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
 * Native CLIs sometimes return a plain final answer despite a JSON-output flag.
 * Accept that as a safe reply, but never downgrade an attempted JSON object into
 * plain text: malformed or schema-invalid objects remain hard failures.
 */
export function parseFinalText(text: string, context: string): StructuredOutput {
  const trimmed = text.trim();
  if (!hasVisibleText(trimmed)) throw new MalformedOutputError(`${context} did not contain visible text`);
  const jsonCandidate = trimmed.replace(LEADING_INVISIBLE_TEXT, "");

  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonCandidate) as unknown;
  } catch {
    if (jsonCandidate.startsWith("{")) {
      throw new MalformedOutputError(`${context} contained a malformed JSON object`);
    }
    return fallbackTextOutput(trimmed, context);
  }

  if (isObject(decoded)) return validateStructuredOutput(decoded);
  if (typeof decoded === "string") return fallbackTextOutput(decoded, context);
  throw new MalformedOutputError(`${context} must be a structured JSON object or non-empty text`);
}

function parseCandidate(candidate: unknown, context: string): StructuredOutput {
  return typeof candidate === "string"
    ? parseFinalText(candidate, context)
    : validateStructuredOutput(candidate);
}

export function parseDirectOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Harness output");
  if (!isObject(value)) return { output: validateStructuredOutput(value) };
  return sessionResult(validateStructuredOutput(structuredCandidate(value)), value.session_id);
}

function jsonLines(stdout: string, context: string): readonly JsonObject[] {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new MalformedOutputError(`${context} output was empty`);
  return lines.map((line) => {
    const value = parseJson(line, context);
    if (!isObject(value)) throw new MalformedOutputError(`${context} event must be an object`);
    return value;
  });
}

export function parseHermesOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Hermes output");
  if (!isObject(value)) return { output: validateStructuredOutput(value) };
  const candidate = value.output ?? value.result ?? value;
  return sessionResult(parseCandidate(candidate, "Hermes result"), value.session_id);
}

export function parseOpenCodeOutput(stdout: string): ParsedHarnessOutput {
  const events = jsonLines(stdout, "OpenCode");
  let sessionId: unknown;
  let candidate: unknown;
  const textParts: string[] = [];
  for (const event of events) {
    if (event.type === "session" && typeof event.id === "string") sessionId = event.id;
    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    if (event.session_id !== undefined) sessionId = event.session_id;
    if (event.type === "result") candidate = event.output ?? event.result;
    if (event.type === "text" && isObject(event.part) && event.part.type === "text"
      && typeof event.part.text === "string") {
      textParts.push(event.part.text);
    }
  }
  if (textParts.length > 0) candidate = textParts.join("");
  if (candidate === undefined) {
    const last = events.at(-1);
    candidate = last?.output ?? last?.result;
  }
  return sessionResult(parseCandidate(candidate, "OpenCode result"), sessionId);
}

export function parseClaudeOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Claude Code output");
  if (!isObject(value)) throw new MalformedOutputError("Claude Code result must be an object");
  const candidate: unknown = value.output ?? value.result;
  return sessionResult(parseCandidate(candidate, "Claude Code result"), value.session_id ?? value.sessionId);
}

export function parseCodexOutput(stdout: string): ParsedHarnessOutput {
  const events = jsonLines(stdout, "Codex");
  let sessionId: unknown;
  let candidate: unknown;
  for (const event of events) {
    if (event.type === "thread.started") sessionId = event.thread_id;
    if (event.session_id !== undefined) sessionId = event.session_id;
    if (event.type === "result") candidate = event.output ?? event.result;
    if (event.type === "item.completed" && isObject(event.item)) {
      if (event.item.type === "agent_message") candidate = event.item.text;
    }
  }
  return sessionResult(parseCandidate(candidate, "Codex agent message"), sessionId);
}

export function parseOpenClawOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "OpenClaw output");
  if (!isObject(value)) throw new MalformedOutputError("OpenClaw result must be an object");

  const seen = new Set<JsonObject>();
  let current: unknown = value;
  let sessionId: unknown;
  for (let depth = 0; depth < MAX_OPENCLAW_UNWRAP_DEPTH; depth += 1) {
    if (!isObject(current)) {
      return sessionResult(parseCandidate(current, "OpenClaw result"), sessionId);
    }
    if (seen.has(current)) throw new MalformedOutputError("OpenClaw result contained a wrapper cycle");
    seen.add(current);
    sessionId ??= current.session_id ?? current.sessionId;

    if (Array.isArray(current.payloads)) {
      const texts = current.payloads
        .filter(isObject)
        .map((payload) => payload.text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
      const payloadText = texts.at(-1);
      if (payloadText !== undefined) {
        return sessionResult(parseCandidate(payloadText, "OpenClaw result"), sessionId);
      }
    }

    const visibleText = typeof current.finalAssistantVisibleText === "string"
      ? current.finalAssistantVisibleText
      : isObject(current.meta) && typeof current.meta.finalAssistantVisibleText === "string"
        ? current.meta.finalAssistantVisibleText
        : undefined;
    if (visibleText !== undefined && visibleText.trim().length > 0) {
      return sessionResult(parseCandidate(visibleText, "OpenClaw result"), sessionId);
    }

    if ("reply" in current) {
      return sessionResult(parseCandidate(current, "OpenClaw result"), sessionId);
    }
    if (Array.isArray(current.choices)) {
      const choices: readonly unknown[] = current.choices;
      const choice = choices[0];
      if (isObject(choice) && isObject(choice.message) && choice.message.content !== undefined) {
        return sessionResult(parseCandidate(choice.message.content, "OpenClaw result"), sessionId);
      }
    }

    const next = current.output ?? current.result;
    if (next === undefined) {
      return sessionResult(parseCandidate(current, "OpenClaw result"), sessionId);
    }
    current = next;
  }
  throw new MalformedOutputError("OpenClaw result exceeded the wrapper nesting limit");
}

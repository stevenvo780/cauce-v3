import { MalformedOutputError } from "../errors.js";
import type { ParsedHarnessOutput } from "../types.js";
import { hasNonBlankText, isObject, parseJson } from "./contract.js";
import {
  failedTurnOutput,
  failureText,
  nativeFailureDetail,
  parseCandidate,
  sessionResult,
} from "./envelopes.js";

const CONTEXT = "Grok result";

/**
 * Grok `--output-format json`: ONE object at turn end; `text` glues every assistant text of the
 * turn and `thought` never becomes the reply. A stopReason other than `end_turn`, or an error
 * object, is a failed turn in Grok's words. The session id survives every object branch: a silent
 * turn after a `cauce_reply` deposit must not fork the conversation.
 */
export function parseGrokOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Grok output");
  if (!isObject(value)) throw new MalformedOutputError("Grok result must be an object");
  const sessionId = value.sessionId ?? value.session_id;
  const candidate = value.text;
  if (value.type === "error") {
    const failure = failureText(value.message) ?? failureText(value.error) ?? "error event";
    return sessionResult(failedTurnOutput(candidate, CONTEXT, failure), sessionId);
  }
  const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
  const failure = nativeFailureDetail(value)
    ?? (stopReason !== undefined && stopReason !== "end_turn" ? `stopReason '${stopReason}'` : undefined);
  if (failure !== undefined) return sessionResult(failedTurnOutput(candidate, CONTEXT, failure), sessionId);
  if (typeof candidate !== "string") throw new MalformedOutputError("Grok result did not include a final text");
  if (!hasNonBlankText(candidate)) {
    return sessionResult(failedTurnOutput(undefined, CONTEXT, "the turn ended without visible text"), sessionId);
  }
  return sessionResult(parseCandidate(candidate, CONTEXT), sessionId);
}

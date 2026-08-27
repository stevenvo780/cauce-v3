import { MalformedOutputError } from "../errors.js";
import type { ParsedHarnessOutput } from "../types.js";
import {
  MAX_OPENCLAW_UNWRAP_DEPTH,
  isObject,
  openclawToolWarningOnly,
  parseJson,
  type JsonObject,
  validateStructuredOutput,
} from "./contract.js";
import {
  claudeFailureDetail,
  codexEventFailureDetail,
  failedTurnOutput,
  failureText,
  nativeFailureDetail,
  parseCandidate,
  sessionResult,
  structuredCandidate,
} from "./envelopes.js";

export function parseDirectOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Harness output");
  if (!isObject(value)) return { output: validateStructuredOutput(value) };
  const failure = nativeFailureDetail(value);
  if (failure !== undefined) {
    return sessionResult(
      failedTurnOutput(structuredCandidate(value), "Harness output", failure),
      value.session_id,
    );
  }
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
  // El sobre del puente y el objeto nativo que trae adentro: cualquiera de los dos puede declarar
  // el fracaso, y ninguno de los dos se estaba mirando.
  const failure = nativeFailureDetail(value)
    ?? (isObject(candidate) ? nativeFailureDetail(candidate) : undefined);
  if (failure !== undefined) {
    return sessionResult(failedTurnOutput(candidate, "Hermes result", failure), value.session_id);
  }
  return sessionResult(parseCandidate(candidate, "Hermes result"), value.session_id);
}

export function parseOpenCodeOutput(stdout: string): ParsedHarnessOutput {
  const events = jsonLines(stdout, "OpenCode");
  let sessionId: unknown;
  let candidate: unknown;
  let failure: string | undefined;
  let failureIndex = -1;
  let candidateIndex = -1;
  const textParts: string[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === "session" && typeof event.id === "string") sessionId = event.id;
    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    if (event.session_id !== undefined) sessionId = event.session_id;
    if (event.type === "result") {
      candidate = event.output ?? event.result;
      candidateIndex = index;
    }
    if (event.type === "text" && isObject(event.part) && event.part.type === "text"
      && typeof event.part.text === "string") {
      textParts.push(event.part.text);
      candidateIndex = index;
    }
    if (event.type === "error" || (isObject(event.part) && event.part.type === "error")) {
      failure = failureText(event.error) ?? failureText(event.message) ?? failureText(event.part) ?? "error event";
      failureIndex = index;
    }
  }
  if (textParts.length > 0) candidate = textParts.join("");
  if (candidate === undefined) {
    const last = events.at(-1);
    candidate = last?.output ?? last?.result;
  }
  if (failure !== undefined && failureIndex > candidateIndex) {
    return sessionResult(failedTurnOutput(candidate, "OpenCode result", failure), sessionId);
  }
  return sessionResult(parseCandidate(candidate, "OpenCode result"), sessionId);
}

export function parseClaudeOutput(stdout: string): ParsedHarnessOutput {
  const value = parseJson(stdout.trim(), "Claude Code output");
  if (!isObject(value)) throw new MalformedOutputError("Claude Code result must be an object");
  const candidate: unknown = value.output ?? value.result;
  const sessionId = value.session_id ?? value.sessionId;
  const failure = claudeFailureDetail(value);
  if (failure !== undefined) {
    return sessionResult(failedTurnOutput(candidate, "Claude Code result", failure), sessionId);
  }
  return sessionResult(parseCandidate(candidate, "Claude Code result"), sessionId);
}

export function parseCodexOutput(stdout: string): ParsedHarnessOutput {
  const events = jsonLines(stdout, "Codex");
  let sessionId: unknown;
  let candidate: unknown;
  let failure: string | undefined;
  let failureIndex = -1;
  let candidateIndex = -1;
  for (const [index, event] of events.entries()) {
    if (event.type === "thread.started") sessionId = event.thread_id;
    if (event.session_id !== undefined) sessionId = event.session_id;
    if (event.type === "result") {
      candidate = event.output ?? event.result;
      candidateIndex = index;
    }
    if (event.type === "item.completed" && isObject(event.item)) {
      if (event.item.type === "agent_message") {
        candidate = event.item.text;
        candidateIndex = index;
      }
    }
    const eventFailure = codexEventFailureDetail(event);
    if (eventFailure !== undefined) {
      failure = eventFailure;
      failureIndex = index;
    }
  }
  // El fracaso gana sólo si es lo ÚLTIMO que dijo el turno: un `error` seguido de un
  // `agent_message` es un reintento interno que terminó bien, y ese sí completó.
  if (failure !== undefined && failureIndex > candidateIndex) {
    return sessionResult(failedTurnOutput(candidate, "Codex agent message", failure), sessionId);
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
    /** Ultimo aviso de openclaw cuando NINGUN payload traia una respuesta de verdad. */
    let avisoDeCola: string | undefined;

    // ANTES de mirar payloads o texto visible: una corrida que el runtime nativo declaró fallida
    // igual deja texto atrás, y ese texto se estaba tomando como resultado exitoso del turno.
    const failure = nativeFailureDetail(current);
    if (failure !== undefined) {
      const spoken = Array.isArray(current.payloads)
        ? current.payloads.filter(isObject).map((payload) => payload.text)
          .filter((text): text is string => typeof text === "string" && text.trim().length > 0).at(-1)
        : undefined;
      return sessionResult(failedTurnOutput(spoken, "OpenClaw result", failure), sessionId);
    }

    if (Array.isArray(current.payloads)) {
      const texts = current.payloads
        .filter(isObject)
        .map((payload) => payload.text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
      // Descarta advertencias de herramienta de cola si existen respuestas reales previas.
      const reales = texts.filter((text) => openclawToolWarningOnly(text) === undefined);
      const payloadText = reales.at(-1);
      if (payloadText !== undefined) {
        return sessionResult(parseCandidate(payloadText, "OpenClaw result"), sessionId);
      }
      avisoDeCola = texts.at(-1);
    }

    const visibleText = typeof current.finalAssistantVisibleText === "string"
      ? current.finalAssistantVisibleText
      : isObject(current.meta) && typeof current.meta.finalAssistantVisibleText === "string"
        ? current.meta.finalAssistantVisibleText
        : undefined;
    if (visibleText !== undefined && visibleText.trim().length > 0) {
      return sessionResult(parseCandidate(visibleText, "OpenClaw result"), sessionId);
    }

    // Si sólo se emitió la advertencia, se retorna para su degradación en validateDeliveryOutput.
    if (avisoDeCola !== undefined) {
      return sessionResult(parseCandidate(avisoDeCola, "OpenClaw result"), sessionId);
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

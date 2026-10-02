import type { TurnOutcome } from "./types.js";

/**
 * codex with sub-agents: the delivery is a CHAIN, not one turn.
 *
 * When the root delegates (`spawn_agent`/`followup_task`) it may close its turn right away with no
 * message while the sub-agents keep working. Measured on socrates: codex never wakes the root on its
 * own (0 of 59 turns started without a user line) and it only writes a sub-agent's FINAL_ANSWER into
 * the root rollout once a root turn is running. So the adapter wakes the root at once, asking it to
 * wait INSIDE the turn (`wait_agent`) and then answer: the sub-agents' reports flush into that turn,
 * and its answer is the delivery's. The waiting happens in a live root turn, so the harvest's usual
 * no-progress measure applies unchanged.
 */

/** What the adapter pastes to wake the root; the chain recognizes its turn by this prefix. */
export const CODEX_WAKE_PREFIX = "[cauce] Cerraste el turno sin respuesta final";
export const CODEX_WAKE_TEXT = `${CODEX_WAKE_PREFIX} y tus subagentes pueden seguir trabajando. No cierres el turno`
  + " todavía: repetí wait_agent (aunque devuelva «Wait completed», porque vuelve con el primer mensaje de cualquiera)"
  + " y mirá list_agents hasta que NINGUNO siga trabajando; después da la respuesta final del pedido del bus: el sobre"
  + " JSON completo, con el mismo cauce_correlation_id de ese pedido. No delegues más.";
/** Wakes per delivery: a root that closes silent twice after being woken is failing, not waiting. */
export const MAX_CODEX_WAKES = 2;

export interface CodexLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

type ChainState = "running" | "wake" | "settled";

export interface CodexChain {
  readonly state: ChainState;
  readonly outcome: TurnOutcome;
  /** Wake turns already in the chain; the harvest pastes another only when it has none in flight. */
  readonly wakes: number;
}

const DELEGATIONS = new Set(["spawn_agent", "followup_task", "send_message"]);
/** A delegation that codex rejected («collab spawn failed: agent thread limit reached», «already exists»). */
const FAILED_OUTPUT = /\b(?:fail(?:ed|ure)?|error|already exists|not found|no such)\b/iu;
/** User-role lines codex writes itself at a turn's start, before the typed text: only these known shapes. */
export const CODEX_PREAMBLE = /^\s*(?:<environment_context\b|<user_instructions\b|<recommended_plugins\b|<codex_internal_context\b|# AGENTS\.md instructions\b)/u;
/** A turn codex starts on its own in goal mode: the same conversation carrying on, not someone else. */
export const CODEX_GOAL = /^\s*<codex_internal_context source="goal"/u;

/** Rejected = an error text instead of the JSON (spawn) or empty (followup) that codex returns on success. */
function rejected(output: string): boolean {
  try {
    if (typeof JSON.parse(output) === "object") return false;
  } catch { /* not JSON: judge the text */ }
  return FAILED_OUTPUT.test(output);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function textOf(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content.map(asObject)
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function outputOf(payload: Record<string, unknown>): string {
  return typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
}

function turnIdOf(payload: Record<string, unknown>): string | undefined {
  const id = asObject(payload.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The final text of one closed turn: its close message, else its last `final_answer` message. */
function answerOf(entries: readonly CodexLine[], key: string, close: Record<string, unknown>): string | undefined {
  const text = asText(close.last_agent_message);
  if (text !== undefined) return text;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entries[index];
    const payload = line?.type === "response_item" ? asObject(line.payload) : undefined;
    if (payload?.type !== "message" || payload.role !== "assistant" || payload.phase !== "final_answer") continue;
    if (turnIdOf(payload) !== key) continue;
    const found = asText(textOf(payload));
    if (found !== undefined) return found;
  }
  return undefined;
}

export function codexChain(entries: readonly CodexLine[], key: string): CodexChain | undefined {
  const start = entries.findIndex((line) => {
    const payload = asObject(line.payload);
    return (line.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === key)
      || (line.type === "response_item" && payload?.type === "message" && payload.role === "user"
        && turnIdOf(payload) === key);
  });
  if (start < 0) return undefined;
  const chain = new Set([key]);
  const open = new Set<string>();
  let outsideTurn: string | undefined; // A turn started after the chain closed, not yet classified.
  const delegations = new Map<string, boolean>(); // call_id -> rejected by codex
  let wakes = 0;
  let foreign = false;
  let last: { key: string; close: Record<string, unknown> } | undefined;
  if (entries[start]?.type !== "event_msg") open.add(key); // The user line came before any task_started we read.
  for (let index = start; index < entries.length; index += 1) {
    const line = entries[index];
    const payload = asObject(line?.payload);
    if (line === undefined || payload === undefined) continue;
    if (line.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") {
      if (chain.has(payload.turn_id)) open.add(payload.turn_id); else if (open.size === 0) outsideTurn = payload.turn_id;
      continue;
    }
    if (line.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const turn = turnIdOf(payload);
      const text = textOf(payload);
      if (turn === undefined || turn !== outsideTurn) continue;
      if (CODEX_GOAL.test(text) && !foreign) {
        chain.add(turn); open.add(turn); // codex carrying on by itself: its answer is the chain's too.
        outsideTurn = undefined;
        continue;
      }
      if (CODEX_PREAMBLE.test(text)) continue;
      if (text.startsWith(CODEX_WAKE_PREFIX) && !foreign) {
        chain.add(turn); open.add(turn); wakes += 1;
      } else {
        foreign = true; // The owner (or anyone else) spoke to the root: the chain cannot continue.
      }
      outsideTurn = undefined;
      continue;
    }
    if (line.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")
      && typeof payload.turn_id === "string") {
      if (chain.has(payload.turn_id)) {
        open.delete(payload.turn_id);
        last = { key: payload.turn_id, close: payload };
      } else if (payload.turn_id === outsideTurn) {
        outsideTurn = undefined; // Closed with nothing typed (e.g. a compaction): not ours, not the owner's.
      }
      continue;
    }
    if (line.type !== "response_item" || typeof payload.call_id !== "string") continue;
    if (payload.type === "function_call" && open.size > 0 && DELEGATIONS.has(String(payload.name))) {
      delegations.set(payload.call_id, false);
    } else if (payload.type === "function_call_output" && delegations.has(payload.call_id)) {
      delegations.set(payload.call_id, rejected(outputOf(payload)));
    }
  }
  const delegated = [...delegations.values()].some((wasRejected) => !wasRejected);
  if (open.size > 0 || last === undefined) {
    return { state: "running", outcome: { kind: "failed", detail: "turno en curso" }, wakes };
  }
  const answer = last.close.type === "task_complete" ? answerOf(entries, last.key, last.close) : undefined;
  const error = asObject(last.close.error);
  const outcome: TurnOutcome = last.close.type === "turn_aborted"
    ? { kind: "failed", detail: `el turno se interrumpió dentro de la terminal antes de responder (${asText(last.close.reason) ?? "sin motivo declarado"})` }
    : error !== undefined && answer === undefined
      ? { kind: "failed", detail: `codex cerró el turno con error (${asText(error.codex_error_info) ?? "sin código"}): ${asText(error.message) ?? "sin mensaje"}` }
    : answer !== undefined
      ? { kind: "answer", text: answer }
      : {
        kind: "failed",
        detail: foreign && delegated
          ? "el turno delegó en subagentes y alguien escribió en la terminal antes de su respuesta final"
          : delegated
            ? `el turno delegó en subagentes y cerró sin respuesta final${wakes > 0 ? ", aun después de despertarlo" : " (no se llegó a despertarlo)"}`
            : "el turno terminó en la terminal sin ningún mensaje del agente",
      };
  // Only a SILENT close after delegating is woken: if the root answered, that is the delivery's answer; an
  // error close (quota, overload, revoked token) is reported as such, never woken into the same wall.
  if (foreign || last.close.type === "turn_aborted" || answer !== undefined || error !== undefined || !delegated
    || wakes >= MAX_CODEX_WAKES) {
    return { state: "settled", outcome, wakes };
  }
  // A turn already started but not yet classified (its first real line may come minutes later): the root is busy.
  return outsideTurn !== undefined ? { state: "running", outcome, wakes } : { state: "wake", outcome, wakes };
}

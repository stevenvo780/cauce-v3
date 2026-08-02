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

// `artifacts` salio de aqui el 2026-08-02: es el campo que menos veces lleva la respuesta y el que
// mas veces el modelo omite cuando no produjo ninguno. Exigirlo costaba el turno ENTERO -- reply
// incluido -- por un `[]` que falta. Ahora se normaliza a lista vacia en parseArtifacts.
const REQUIRED_OUTPUT_KEYS = ["reply", "messages", "status", "retryable"] as const;
/** Cota del rastreo de sobres embebidos; con dos ya alcanza para declarar ambigüedad. */
const MAX_EMBEDDED_ENVELOPE_CANDIDATES = 64;

function requiredKeys(value: JsonObject): void {
  for (const key of REQUIRED_OUTPUT_KEYS) {
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
function parseNotify(value: unknown): { directives: readonly NotifyDirective[]; descartes: readonly string[] } {
  // Nada de lo que venga en `notify` puede tumbar el turno. Antes cada regla era un throw, y un
  // throw aqui se lleva puesto el `reply` ENTERO: el agente hacia el trabajo, escribia su
  // respuesta, y el duenio recibia un error de esquema. Medido el 2026-08-02 con kratos, dos veces:
  // escribio {"to":"Miguel"} -- el nombre de la persona, no un handle -- y se perdio un diagnostico
  // completo de por que Graf no entregaba al OMS.
  //
  // `notify` es accesorio: si viene mal, se descarta y se le dice al agente que se descarto y por
  // que, para que lo corrija en el proximo turno. La respuesta siempre sobrevive.
  const descartes: string[] = [];
  if (!Array.isArray(value)) {
    return { directives: [], descartes: ["'notify' no era una lista; se descarto entera"] };
  }
  const directives: NotifyDirective[] = [];
  let aggregateBodyBytes = 0;
  for (const [index, entry] of value.entries()) {
    if (directives.length >= MAX_NOTIFY_DIRECTIVES) {
      descartes.push(`se descartaron las notificaciones a partir de la ${MAX_NOTIFY_DIRECTIVES + 1}: el limite es ${MAX_NOTIFY_DIRECTIVES}`);
      break;
    }
    if (!isObject(entry) || typeof entry.to !== "string" || typeof entry.body !== "string") {
      descartes.push(`notify[${index}] descartada: necesita 'to' y 'body' de texto`);
      continue;
    }
    if (!CANONICAL_NOTIFY_HANDLE.test(entry.to)) {
      descartes.push(`notify[${index}] descartada: "${entry.to}" no es un handle de destino. Un handle es minusculas, digitos, punto, guion o guion bajo (por ejemplo steven_dm); NO es el nombre de la persona ni un alias de agente`);
      continue;
    }
    if (typeof entry.kind !== "string" || !NOTIFY_KINDS.includes(entry.kind as NotifyKind)) {
      descartes.push(`notify[${index}] descartada: 'kind' debe ser uno de ${NOTIFY_KINDS.join(", ")}`);
      continue;
    }
    if (!hasVisibleText(entry.body)) {
      descartes.push(`notify[${index}] descartada: 'body' no tiene texto visible`);
      continue;
    }
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    if (bodyBytes > MAX_NOTIFY_BODY_BYTES) {
      descartes.push(`notify[${index}] descartada: 'body' supera el limite de bytes UTF-8`);
      continue;
    }
    if (aggregateBodyBytes + bodyBytes > MAX_NOTIFY_AGGREGATE_BYTES) {
      descartes.push(`notify[${index}] y las siguientes descartadas: se supero el limite agregado de bytes`);
      break;
    }
    aggregateBodyBytes += bodyBytes;
    directives.push({ to: entry.to, body: entry.body, kind: entry.kind as NotifyKind });
  }
  return { directives, descartes };
}


function parseArtifacts(value: unknown): readonly OutputArtifact[] {
  // Ausente == ninguno. Es lo que el modelo quiere decir cuando lo omite, y exigirlo costaba el
  // turno entero por un campo que casi siempre es [].
  if (value === undefined || value === null) return [];
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
  const notificaciones = value.notify === undefined
    ? { directives: [] as readonly NotifyDirective[], descartes: [] as readonly string[] }
    : parseNotify(value.notify);
  // El agente tiene que enterarse de lo que se descarto, o repetira el mismo error cada turno.
  const aviso = notificaciones.descartes.length === 0
    ? ""
    : `\n\n[Cauce] ${notificaciones.descartes.join(". ")}.`;
  return {
    reply: aviso === ""
      ? value.reply
      : `${value.reply === null || value.reply.trim() === "" ? "(sin respuesta)" : value.reply}${aviso}`,
    messages: parseMessages(value.messages),
    notify: notificaciones.directives,
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
    // Esto era un `throw`, y el throw se llevaba puesto el `reply` ENTERO. El agente escribia su
    // diagnostico, el turno terminaba en "failed", y al remitente le llegaba unicamente
    // "<alias> could not complete the delegated request: ...". Medido el 2026-08-01: 98 entregas
    // perdieron su respuesta asi (kant 23, dedalo 15, kratos 12). Un caso concreto: zeus explico
    // en 1.900 caracteres que el fallo era un sshd ausente y no una ruta, socrates nunca lo vio y
    // siguio media hora buscando donde no era.
    //
    // Descartar los mensajes no pierde nada que hoy exista: un turno "failed" no se materializa
    // igual, y el gateway lo compuerta aguas abajo. Lo que se gana es que la respuesta sobreviva.
    const descartadas = output.messages.length;
    const aviso = `[Cauce] Se descartaron ${descartadas} delegacion(es): un turno que termina en "failed" no materializa mensajes. Si siguen haciendo falta, repetilas en un turno que cierre en "done", o usa "notify" para avisarle a una persona.`;
    output = {
      ...output,
      messages: [],
      reply: output.reply === null || output.reply.trim() === ""
        ? aviso
        : `${output.reply}\n\n${aviso}`,
    };
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

/**
 * BUG: un turno que el harness declaró FALLIDO se registraba como 'done'.
 *
 * Los dialectos nativos traen su propia señal de fracaso, y ninguna se estaba mirando: se tomaba
 * el texto final del turno y se lo daba por bueno. Un `error_max_turns` de Claude o un
 * `turn.failed` de Codex salen con código 0 y con texto en el campo de resultado, así que
 * `shared.ts` —que sólo mira `exitCode` y `status`— tampoco los podía atrapar. Resultado: el
 * sistema cree que salió bien trabajo que fracasó, y nadie lo reintenta ni lo revisa.
 *
 * Campos verificados contra los binarios instalados el 2026-07-29:
 *  - claude 2.1.220: `{type:"result", subtype:"success"|"error_max_turns"|"error_during_execution"
 *    |"error_max_budget_usd"|"error_max_structured_output_retries"|"error", is_error:bool, result, …}`
 *  - codex 0.145.0 (`exec --json`): eventos `turn.failed`, `error`, e `item.completed` con
 *    `item.type:"error"`, junto a `thread.started`/`turn.completed`/`item.completed`.
 *  - openclaw / hermes: los puentes envuelven el objeto nativo (`{result:…}`), y el fracaso
 *    nativo viaja en `ok:false`, `error` o un `status` de la familia de fallo.
 *
 * `retryable:false` a propósito: el turno YA se ejecutó y ya tuvo efectos, así que reintentarlo
 * duplica trabajo. Es el mismo criterio que `EXECUTION_TIMEOUT_AMBIGUOUS` y
 * `PROCESS_EXIT_AMBIGUOUS`. La entrega queda `failed` con el texto del harness en el ack, que es
 * lo que hace visible el fracaso en vez de esconderlo.
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

function failureText(value: unknown, depth = 0): string | undefined {
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
 * Señal de fracaso en un objeto envoltorio nativo. El sobre del contrato queda EXPLÍCITAMENTE
 * fuera: su `status:"failed"` ya lo valida `validateStructuredOutput`, y confundirlo con un
 * `status` nativo lo haría pasar dos veces por el mismo molino.
 */
function nativeFailureDetail(value: JsonObject): string | undefined {
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
function claudeFailureDetail(value: JsonObject): string | undefined {
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
function codexEventFailureDetail(event: JsonObject): string | undefined {
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
    // Un turno que el propio harness declaró fallido no debe además morir por el parser.
    return undefined;
  }
}

function boundedDetail(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_FAILURE_DETAIL_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, MAX_FAILURE_DETAIL_BYTES).toString("utf8")}…`;
}

/**
 * Convierte una señal nativa de fracaso en un resultado `failed` de verdad. Si el harness llegó a
 * emitir un sobre que YA dice `failed`, se respeta tal cual (conserva su `reply` y su
 * `retryable`); en cualquier otro caso se sintetiza el fracaso conservando el texto del harness.
 *
 * `messages: []` no es un descarte silencioso: un turno fallido nunca materializa delegaciones
 * —`validateDeliveryOutput` lo prohíbe explícitamente—, y la entrega termina en `failed`, visible
 * en el ack y en las dead-letters.
 */
function failedTurnOutput(candidate: unknown, context: string, detail: string): StructuredOutput {
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
 * Recorta los objetos JSON de primer nivel embebidos en un texto.
 *
 * Una sola pasada con conciencia de cadenas y escapes, así que unas llaves adentro de un string
 * (`"usá {\"a\":1}"`) no abren ni cierran nada. No se miran objetos anidados: el sobre del
 * contrato siempre es un objeto de primer nivel del texto.
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
 * BUG: el sobre del contrato se perdía en silencio y con él TODAS las delegaciones.
 *
 * Un modelo devuelve el sobre precedido de una frase ("Listo, delegué a kant.\n{…}") o dentro de
 * una valla con texto alrededor. `JSON.parse` falla sobre el texto entero, el texto no empieza con
 * `{`, y el fallback lo convertía en un `reply` de texto plano con `messages: []`. El agente creía
 * haber delegado, la entrega se cerraba en `done` y el destinatario NUNCA recibía el trabajo.
 * Medido en prod el 2026-07-29: 160 respuestas con el sobre publicado como texto desde el 23-jul,
 * 39 de ellas con un `messages` NO VACÍO — 39 delegaciones destruidas en seis días.
 *
 * Qué debe pasar: nunca descartar el sobre en silencio. Y entre las dos opciones,
 *  - degradar con aviso NO sirve: `messages` es el único mecanismo durable para mandarle trabajo a
 *    otro agente, así que un aviso dentro del `reply` le llega a una persona y el agente destino
 *    sigue sin recibir nada. La delegación se pierde igual, sólo que con nota al pie.
 *  - fallar la entrega sí es aceptable como PISO, pero `MALFORMED_OUTPUT` es no reintentable: el
 *    trabajo también se pierde, sólo que ruidosamente.
 * Por eso: se RECUPERA el sobre cuando se lo puede identificar sin ambigüedad, y sólo si no se
 * puede se falla fuerte. El texto que no trae sobre alguno sigue cayendo al fallback de siempre.
 *
 * Deliberadamente estricto para no delegar de más: un candidato sólo cuenta si trae las CINCO
 * claves obligatorias del contrato; dos o más candidatos son ambigüedad y se rechaza sin adivinar.
 * Y el sobre recuperado pasa igual por `validateStructuredOutput` y después por
 * `validateDeliveryOutput`, que rechaza destinos desconocidos, ausentes o fuera de línea.
 */
function recoverEmbeddedEnvelope(text: string, context: string): StructuredOutput | undefined {
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
    throw new MalformedOutputError(
      `${context} embedded more than one structured output envelope in plain text; refusing to guess which delegation is real`,
    );
  }
  return validateStructuredOutput(envelopes[0]);
}

function recoverOrFallback(text: string, context: string): StructuredOutput {
  const recovered = recoverEmbeddedEnvelope(text, context);
  return recovered ?? fallbackTextOutput(text, context);
}

/**
 * Native CLIs sometimes return a plain final answer despite a JSON-output flag.
 * Accept that as a safe reply, but never downgrade an attempted JSON object into
 * plain text: malformed or schema-invalid objects remain hard failures.
 */
/**
 * Desenvuelve la valla de código con la que un modelo suele rodear su JSON.
 *
 * Un LLM al que le pedís un objeto JSON te lo devuelve envuelto en ```json … ``` con muchísima
 * frecuencia: es lo que hace un modelo bien educado cuando cree que le hablás a un humano. El
 * parser no lo contemplaba, así que `JSON.parse` fallaba, el texto no empezaba con `{` y la salida
 * entera caía al fallback de texto plano: el usuario recibía por Telegram el volcado crudo
 * `{"reply":"…","messages":[],"status":"done"}` en vez de la respuesta. Medido el 2026-07-27: 7
 * mensajes así en 12 h, y es la misma causa de los 32 "contained a malformed JSON object" de la
 * semana, donde la valla además escondía un objeto realmente truncado.
 *
 * Se desenvuelve SÓLO si adentro hay algo con forma de objeto o arreglo. Una respuesta legítima
 * que empieza con un bloque de código —alguien que contesta con un fragmento de programa— no tiene
 * `{` ni `[` como primer carácter útil, así que sigue tratándose como texto y no se la reinterpreta.
 */
const CODE_FENCE = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/u;

function unwrapCodeFence(candidate: string): string {
  const match = CODE_FENCE.exec(candidate);
  if (match === null) return candidate;
  const inner = (match[1] ?? "").trim();
  return inner.startsWith("{") || inner.startsWith("[") ? inner : candidate;
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
      throw new MalformedOutputError(`${context} contained a malformed JSON object`);
    }
    return recoverOrFallback(trimmed, context);
  }

  if (isObject(decoded)) return validateStructuredOutput(decoded);
  if (typeof decoded === "string") return recoverOrFallback(decoded, context);
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

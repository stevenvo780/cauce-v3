import {
  AGENT_TO_AGENT_MESSAGE_TYPES,
  EgressHandleSchema,
  MAX_NOTIFY_BODY_BYTES,
  NOTIFY_KINDS,
} from "@cauce/protocol";
import { AdapterError, MalformedOutputError } from "../errors.js";
import type {
  NotifyDirective,
  NotifyKind,
  OutputArtifact,
  RelayMessage,
  StructuredOutput,
} from "../types.js";

export type JsonObject = Record<string, unknown>;

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
export const MAX_NOTIFY_AGGREGATE_BYTES = 8 * 1024;
export { MAX_NOTIFY_BODY_BYTES, NOTIFY_KINDS };
export const MAX_OPENCLAW_UNWRAP_DEPTH = 8;
// Patterns to detect OpenClaw tool warnings emitted in place of real responses.
const OPENCLAW_TOOL_WARNING = /^⚠️? \u{1F6E0}️? /u;
const OPENCLAW_MESSAGE_WARNING = /^⚠️? ✉️? message failed(?::|$)/iu;
const CANONICAL_MESSAGE_TARGET = /^(?:@all|[a-z][a-z0-9_-]{0,63})$/u;
const INVISIBLE_TEXT = /[\p{White_Space}\p{Cf}\p{Cc}\p{Mn}\p{Me}]/gu;
export const LEADING_INVISIBLE_TEXT = /^[\p{White_Space}\p{Cf}\p{Cc}\p{Mn}\p{Me}]+/u;

export function hasVisibleText(value: string): boolean {
  return value.replace(INVISIBLE_TEXT, "").length > 0;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedOutputError(`${context} did not contain valid JSON`);
  }
}

/**
 * Solo `reply` es obligatoria: es el trabajo del turno. `messages`, `status` y `retryable` son
 */
export const REQUIRED_OUTPUT_KEYS = ["reply"] as const;
/** Andamiaje que se normaliza cuando falta, registrando el aviso para que el agente lo aprenda. */
export const NORMALIZED_WHEN_ABSENT = ["messages", "status", "retryable"] as const;
/** Cap on the embedded envelope scan; two are enough to declare ambiguity. */
export const MAX_EMBEDDED_ENVELOPE_CANDIDATES = 64;

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
    throw new MalformedOutputError(`'messages' exceeded the ${String(MAX_RELAY_MESSAGES)} message limit`);
  }
  let aggregateBodyBytes = 0;
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.to !== "string" || typeof entry.body !== "string") {
      throw new MalformedOutputError(`messages[${String(index)}] must contain string 'to' and 'body'`);
    }
    if (!CANONICAL_MESSAGE_TARGET.test(entry.to)) {
      throw new MalformedOutputError(
        `messages[${String(index)}].to must be a canonical lowercase alias or reserved target`,
      );
    }
    if (!hasVisibleText(entry.body)) {
      throw new MalformedOutputError(`messages[${String(index)}].body must contain visible text`);
    }
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    if (bodyBytes > MAX_RELAY_BODY_BYTES) {
      throw new MalformedOutputError(`messages[${String(index)}].body exceeded the UTF-8 byte limit`);
    }
    aggregateBodyBytes += bodyBytes;
    if (aggregateBodyBytes > MAX_RELAY_AGGREGATE_BYTES) {
      throw new MalformedOutputError("'messages' bodies exceeded the aggregate UTF-8 byte limit");
    }
    return { to: entry.to, body: entry.body };
  });
}

function parseNotify(value: unknown): { directives: readonly NotifyDirective[]; descartes: readonly string[] } {
  // Malformed notify directives are discarded while recording the notice, without aborting the turn.
  const descartes: string[] = [];
  if (!Array.isArray(value)) {
    return { directives: [], descartes: ["'notify' no era una lista; se descarto entera"] };
  }
  const directives: NotifyDirective[] = [];
  let aggregateBodyBytes = 0;
  for (const [index, entry] of value.entries()) {
    if (directives.length >= MAX_NOTIFY_DIRECTIVES) {
      descartes.push(`se descartaron las notificaciones a partir de la ${String(MAX_NOTIFY_DIRECTIVES + 1)}: el limite es ${String(MAX_NOTIFY_DIRECTIVES)}`);
      break;
    }
    if (!isObject(entry) || typeof entry.to !== "string" || typeof entry.body !== "string") {
      descartes.push(`notify[${String(index)}] descartada: necesita 'to' y 'body' de texto`);
      continue;
    }
    if (!EgressHandleSchema.safeParse(entry.to).success) {
      descartes.push(`notify[${String(index)}] descartada: "${entry.to}" no es un handle de destino. Un handle es minusculas, digitos, punto, guion o guion bajo (por ejemplo handle_usuario); NO es el nombre de la persona ni un alias de agente`);
      continue;
    }
    if (typeof entry.kind !== "string" || !NOTIFY_KINDS.includes(entry.kind as NotifyKind)) {
      descartes.push(`notify[${String(index)}] descartada: 'kind' debe ser uno de ${NOTIFY_KINDS.join(", ")}`);
      continue;
    }
    if (!hasVisibleText(entry.body)) {
      descartes.push(`notify[${String(index)}] descartada: 'body' no tiene texto visible`);
      continue;
    }
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    if (bodyBytes > MAX_NOTIFY_BODY_BYTES) {
      descartes.push(`notify[${String(index)}] descartada: 'body' supera el limite de bytes UTF-8`);
      continue;
    }
    if (aggregateBodyBytes + bodyBytes > MAX_NOTIFY_AGGREGATE_BYTES) {
      descartes.push(`notify[${String(index)}] y las siguientes descartadas: se supero el limite agregado de bytes`);
      break;
    }
    aggregateBodyBytes += bodyBytes;
    directives.push({ to: entry.to, body: entry.body, kind: entry.kind as NotifyKind });
  }
  return { directives, descartes };
}


function parseArtifacts(value: unknown): readonly OutputArtifact[] {
  // If absent or null, normalize to an empty list.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MalformedOutputError("'artifacts' must be an array");
  }
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.uri !== "string") {
      throw new MalformedOutputError(`artifacts[${String(index)}] must contain string 'name' and 'uri'`);
    }
    if (entry.media_type !== undefined && typeof entry.media_type !== "string") {
      throw new MalformedOutputError(`artifacts[${String(index)}].media_type must be a string`);
    }
    if (entry.sha256 !== undefined && typeof entry.sha256 !== "string") {
      throw new MalformedOutputError(`artifacts[${String(index)}].sha256 must be a string`);
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
  // Ausencias del andamiaje: se normalizan y se listan. Presencias mal formadas siguen fallando.
  const ausentes = NORMALIZED_WHEN_ABSENT.filter((key) => !(key in value));
  const status = value.status === undefined ? "done" : value.status;
  if (status !== "done" && status !== "failed") {
    throw new MalformedOutputError("'status' must be 'done' or 'failed'");
  }
  const retryable = value.retryable === undefined ? false : value.retryable;
  if (typeof retryable !== "boolean") {
    throw new MalformedOutputError("'retryable' must be a boolean");
  }
  const notificaciones = value.notify === undefined
    ? { directives: [] as readonly NotifyDirective[], descartes: [] as readonly string[] }
    : parseNotify(value.notify);
  // The agent must learn what was discarded, or it will repeat the same error every turn.
  const notas = [...notificaciones.descartes];
  if (ausentes.length > 0) {
    notas.push(
      `faltaba ${ausentes.map((key) => `'${key}'`).join(", ")} en el sobre; se normalizo para no `
      + "perder el turno, pero el sobre tiene que llevar los siete campos",
    );
  }
  const aviso = notas.length === 0 ? "" : `\n\n[Cauce] ${notas.join(". ")}.`;
  return {
    reply: aviso === ""
      ? value.reply
      : `${value.reply === null || value.reply.trim() === "" ? "(sin respuesta)" : value.reply}${aviso}`,
    messages: value.messages === undefined ? [] : parseMessages(value.messages),
    notify: notificaciones.directives,
    status,
    // `retryable` has no meaning after a successful terminal result. Native
    // models occasionally emit the redundant contradictory pair
    // `{status:"done", retryable:true}`; canonicalize that one pair without
    // re-executing or weakening validation of the field's type.
    retryable: status === "done" ? false : retryable,
    artifacts: parseArtifacts(value.artifacts),
  };
}

/** Truncates at the byte limit without splitting a multibyte character in half. */
export function recortarABytes(texto: string, limite: number): string {
  if (Buffer.byteLength(texto, "utf8") <= limite) return texto;
  const marca = "\n[Cauce] (recortado por limite de tamano)";
  const disponible = Math.max(0, limite - Buffer.byteLength(marca, "utf8"));
  const cortado = new TextDecoder("utf-8", { fatal: false })
    .decode(Buffer.from(texto, "utf8").subarray(0, disponible))
    // The non-fatal decoder leaves U+FFFD if the cut split a character: that tail is discarded.
    .replace(/\uFFFD+$/gu, "");
  return `${cortado}${marca}`;
}

/** Discards `messages` addressed to the sender and adds them to the notice or reply to avoid cyclic bounces. */
function descartarReboteAlRemitente(
  output: StructuredOutput,
  senderAlias: string | undefined,
): StructuredOutput {
  if (senderAlias === undefined || output.messages.length === 0) return output;
  const rebotes = output.messages.filter((message) => message.to === senderAlias);
  if (rebotes.length === 0) return output;

  const aviso = `[Cauce] Se descarto ${String(rebotes.length)} mensaje(s) de "messages" dirigido(s) a "${senderAlias}", que es quien te escribio: al remitente se le contesta SOLO por "reply", que vuelve solo a el. "messages" es unicamente para delegar a un TERCER agente.`;
  const propio = output.reply === null || output.reply.trim() === "" ? "" : output.reply;
  const cuerpo = propio === ""
    ? recortarABytes(rebotes.map((message) => message.body).join("\n\n"), MAX_FINAL_TEXT_BYTES)
    : propio;

  return {
    ...output,
    messages: output.messages.filter((message) => message.to !== senderAlias),
    reply: cuerpo === "" ? aviso : `${cuerpo}\n\n${aviso}`,
  };
}

/**
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
    // Discards delegated messages on failed turns, keeping the answer text.
    const descartadas = output.messages.length;
    const aviso = `[Cauce] Se descartaron ${String(descartadas)} delegacion(es): un turno que termina en "failed" no materializa mensajes. Si siguen haciendo falta, repetilas en un turno que cierre en "done", o usa "notify" para avisarle a una persona.`;
    output = {
      ...output,
      messages: [],
      reply: output.reply === null || output.reply.trim() === ""
        ? aviso
        : `${output.reply}\n\n${aviso}`,
    };
  }

  output = descartarReboteAlRemitente(output, context.senderAlias);

  const internalMessage = (AGENT_TO_AGENT_MESSAGE_TYPES as readonly string[])
    .includes(context.messageType ?? "");
  validateDelegationTargets(output.messages, context, internalMessage);

  if (output.reply !== null && !hasVisibleText(output.reply)) {
    throw new AdapterError(
      "INVISIBLE_REPLY",
      "Harness reply must be null or contain visible text",
      false,
    );
  }

  if (output.status !== "done") return output;

  // If the answer is only a broken-tool warning, it is degraded to failed.
  if (output.messages.length === 0) {
    const volcado = openclawToolWarningOnly(output.reply);
    if (volcado !== undefined) {
      return {
        ...output,
        status: "failed",
        retryable: false,
        reply: `No pude completar la respuesta: se me rompio una herramienta y el turno cerro sin que yo llegara a escribir nada. Volve a preguntarme y lo reintento.\n\n[Cauce] Detalle tecnico del harness: ${volcado}`,
      };
    }
  }

  // If the turn ended in 'done' without reply or delegations, it is converted to failed with an explanation.
  if (output.reply === null && output.messages.length === 0) {
    return {
      ...output,
      status: "failed",
      retryable: false,
      reply: "Cerre el turno sin escribir respuesta, asi que no tengo nada que contarte todavia. No es que no haya nada que decir: es que no llegue a redactarlo. Volve a preguntarme.\n\n[Cauce] El turno termino en \"done\" con 'reply' vacio y sin delegaciones, que es exactamente el sintoma de un harness que corto antes de responder.",
    };
  }

  return output;
}

/**
 * Detects whether the text is exclusively an OpenClaw tool error or warning notice.
 */
export function openclawToolWarningOnly(reply: string | null): string | undefined {
  if (reply === null) return undefined;
  const texto = reply.trim();
  // A multiline text indicates there is additional content beyond the notice.
  if (texto.length === 0 || /[\n\r]/u.test(texto)) return undefined;
  if (OPENCLAW_TOOL_WARNING.test(texto)) return texto;
  if (OPENCLAW_MESSAGE_WARNING.test(texto)) return texto;
  return undefined;
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

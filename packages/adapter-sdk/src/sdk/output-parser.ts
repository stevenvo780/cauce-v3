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
// Los dos avisos que openclaw 2026.6.6 emite como un payload de texto MAS, no como respuesta.
// Verificado leyendo el binario instalado en el contenedor `claw`
// (/usr/lib/node_modules/openclaw/dist/helpers-CYQZyDV5.js:119-127), donde el propio openclaw los
// clasifica con `isCronToolWarning` (startsWith "⚠️ 🛠️ ") e `isCronMessagePresentationWarning`
// (el texto es "⚠️ ✉️ message failed" o empieza por "⚠️ ✉️ message failed:"), y los marca en el
// payload con `isError:true` + `nonTerminalToolErrorWarning`. O sea: el origen del string NO es
// nuestro —no aparece en ningun fichero de packages/— y openclaw ya sabe que no es una respuesta.
// El selector de variacion va opcional porque el emisor no garantiza emitirlo.
const OPENCLAW_TOOL_WARNING = /^⚠️? \u{1F6E0}️? /u;
const OPENCLAW_MESSAGE_WARNING = /^⚠️? ✉️? message failed(?::|$)/iu;
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

/** Corta en el limite de bytes sin partir un caracter multibyte por la mitad. */
function recortarABytes(texto: string, limite: number): string {
  if (Buffer.byteLength(texto, "utf8") <= limite) return texto;
  const marca = "\n[Cauce] (recortado por limite de tamano)";
  const disponible = Math.max(0, limite - Buffer.byteLength(marca, "utf8"));
  const cortado = new TextDecoder("utf-8", { fatal: false })
    .decode(Buffer.from(texto, "utf8").subarray(0, disponible))
    // El decoder no fatal deja U+FFFD si el corte partio un caracter: se descarta esa cola.
    .replace(/\uFFFD+$/gu, "");
  return `${cortado}${marca}`;
}

/**
 * Un `messages` dirigido al REMITENTE ya no cuesta el turno entero.
 *
 * Esto era `throw AGENT_MESSAGE_PING_PONG`, no reintentable, y el throw se llevaba puesto el
 * `reply` ENTERO: el agente hacia el trabajo, lo escribia, y no llegaba a nadie. Medido sobre
 * 48 h (2026-08-04/05): 5 turnos perdidos asi en 5 alias de 4 tenants —argos y jarvis (Steven),
 * hegel (Jhon), janus (Miguel), midas (Pablo)—; 7 en total sobre 6 alias contando vulcano. El de
 * midas llevaba una lista de 11 prospectos YA HECHA.
 *
 * Y la culpa no era del agente: el `AGENTS.md` de 5 contenedores exige que todo envio que el
 * agente afirme haber hecho este en `messages`, sin excepcion para el remitente. El agente que
 * obedecia al pie de la letra perdia el turno.
 *
 * Mismo principio, mismo patron y mismo precio que `parseNotify` y que las delegaciones de un
 * turno "failed": ningun campo accesorio mal formado puede costar el trabajo. El `reply` ES el
 * trabajo; `messages` es un accesorio, y encima este tiene un canal correcto y evidente al que
 * caer —el `reply` vuelve solo a quien escribio—, asi que descartarlo no pierde ni el destino.
 *
 * El descarte NUNCA es mudo: deja el motivo, el alias y la regla dentro del `reply`, que es
 * durable en `deliveries.result.output.reply`. Descartar en silencio es lo que nos costo dias de
 * diagnostico en otros bugs.
 *
 * El resto del contrato de destinos no se ablanda: self, desconocido, ambiguo y fuera de linea
 * siguen siendo error duro en `validateDelegationTargets`, porque ninguno tiene a donde caer.
 */
function descartarReboteAlRemitente(
  output: StructuredOutput,
  senderAlias: string | undefined,
): StructuredOutput {
  if (senderAlias === undefined || output.messages.length === 0) return output;
  const rebotes = output.messages.filter((message) => message.to === senderAlias);
  if (rebotes.length === 0) return output;

  const aviso = `[Cauce] Se descarto ${rebotes.length} mensaje(s) de "messages" dirigido(s) a "${senderAlias}", que es quien te escribio: al remitente se le contesta SOLO por "reply", que vuelve solo a el. "messages" es unicamente para delegar a un TERCER agente.`;
  const propio = output.reply === null || output.reply.trim() === "" ? "" : output.reply;
  // El cuerpo rebotado iba al MISMO destinatario que el `reply`, asi que plegarlo ahi no lo
  // desvia: lo entrega por el canal correcto. Solo se pliega cuando el turno no dejo respuesta
  // propia —el caso en que, si no, el entregable se perderia entero—; si ya hay `reply`, el
  // trabajo ya esta dicho y repetirlo duplicaria el texto que lee la persona.
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

  output = descartarReboteAlRemitente(output, context.senderAlias);

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

  // Un aviso de herramienta NO es una respuesta, aunque el turno diga "done". Medido el
  // 2026-08-02 sobre produccion: 30 entregas `done` cuyo `reply` ENTERO era una sola linea
  // de aviso de openclaw, con CERO delegaciones en las 30. Eso es lo que recibieron Pablo
  // (seneca/grp.pablo, 3 el 26-jul) y Jhon (hegel/grp.jhon, 1 el 28-jul) al preguntar por su
  // proyecto: creyeron que el agente les contestaba y era el volcado de una herramienta rota.
  // El grueso lo comio Steven en grp.steven (jarvis 19, janus 3, midas 2, hegel 1, seneca 1).
  //
  // Se degrada a "failed" y no se tira `throw`: un throw deja la entrega SIN `result` —medido:
  // las cuatro de janus del 27-jul tienen `result` NULL— y entonces la persona no recibe nada.
  // Con "failed" + texto, `agentResponseText` de packages/store usa el `reply` y el humano lee
  // una frase que entiende, mientras las metricas siguen contando el turno como lo que fue.
  if (output.messages.length === 0) {
    const volcado = openclawToolWarningOnly(output.reply);
    if (volcado !== undefined) {
      return {
        ...output,
        status: "failed",
        // El turno ya corrio y ya tuvo efectos; reintentarlo los duplica. Mismo criterio que
        // `failedTurnOutput` y que EXECUTION_TIMEOUT_AMBIGUOUS.
        retryable: false,
        reply: `No pude completar la respuesta: se me rompio una herramienta y el turno cerro sin que yo llegara a escribir nada. Volve a preguntarme y lo reintento.\n\n[Cauce] Detalle tecnico del harness: ${volcado}`,
      };
    }
  }

  // A notification is a side effect, never the result of the delivery: an agent
  // cannot replace its answer to the caller with a DM to a human.
  //
  // Esto era un `throw MISSING_FINAL_REPLY`, y el throw se llevaba puesto el turno ENTERO.
  // Medido el 2026-08-02 en produccion: cuatro entregas a janus el 27-jul (16:13, 16:16, 18:24,
  // 18:27) murieron asi. Eran las cuatro preguntas seguidas de Miguel desde grp.miguel sobre
  // accesos y estado de Demeter/Graf ("hola, como estas. Cuantame en que vamos...",
  // "explicame uno a uno de los links...", "sabes que perfiles tenemos en Demeter..."). Las
  // cuatro quedaron `status=failed` con `result` NULL: Miguel no recibio NADA, ni respuesta ni
  // aviso, y no hubo contestacion posterior.
  //
  // El guard sigue siendo correcto en su diagnostico —un "done" sin reply y sin delegaciones
  // de verdad no produjo nada— asi que NO se convierte en "done": eso ensuciaria las metricas y
  // dejaria al alias pareciendo sano mientras no contesta. Lo que cambia es el precio: en vez de
  // un error sin cuerpo, un turno "failed" QUE LLEVA TEXTO. Asi la persona del otro lado lee una
  // frase honesta en vez de esperar media hora un mensaje que nunca llega, y el `notify` y los
  // `artifacts` que el turno si haya producido sobreviven en el output en lugar de perderse.
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
 * Openclaw emite sus avisos de herramienta rota como un payload de texto mas, y ese payload cae
 * AL FINAL del turno. Devuelve el aviso cuando el `reply` completo es SOLO eso, y `undefined`
 * en cualquier otro caso.
 *
 * La regla es deliberadamente estrecha —una sola linea, y que el aviso ABRA el texto— porque
 * mencionar el aviso dentro de una respuesta real es legitimo y frecuente. Medido el 2026-08-02
 * sobre produccion: hay 256 entregas `done` cuyo reply contiene el simbolo de aviso; 131 no
 * empiezan por el, 125 si, y de esas 125 solo 30 son de una sola linea. Esas 30 son exactamente
 * las que matchean estos dos patrones, y son las unicas que se tocan. Las otras 226 son
 * respuestas de verdad y quedan intactas: el caso que no se puede romper es argos explicandole
 * a seneca, en 2.685 caracteres, que "tu entrega volvio como `⚠️ ✉️ Message failed`, sin
 * cuerpo" —eso es analisis del fallo, no el fallo— y jarvis con 15.480 caracteres de informe
 * que citan el aviso a mitad de texto.
 */
function openclawToolWarningOnly(reply: string | null): string | undefined {
  if (reply === null) return undefined;
  const texto = reply.trim();
  // Multilinea == hay contenido ademas del aviso. En las 30 entregas medidas el volcado era
  // SIEMPRE una sola linea (de 20 a 487 caracteres).
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
    // Aca vivia `AGENT_MESSAGE_PING_PONG`. Ya no: `descartarReboteAlRemitente` corre ANTES y saca
    // esos mensajes, asi que este bucle nunca ve uno. Dejarlo como throw seria codigo muerto que
    // ademas sostiene la creencia falsa de que rebotar al remitente todavia mata el turno.

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
const EMBEDDED_CODE_FENCE = /```[A-Za-z0-9_-]*[\t ]*\r?\n/gu;

function unwrapCodeFence(candidate: string): string {
  const match = CODE_FENCE.exec(candidate);
  if (match === null) return candidate;
  const inner = (match[1] ?? "").trim();
  return inner.startsWith("{") || inner.startsWith("[") ? inner : candidate;
}

/**
 * Encuentra un objeto que empezo dentro de una valla aunque la valla o el objeto no hayan
 * alcanzado a cerrar. Fuera de una valla no se busca una llave arbitraria dentro de la prosa: un
 * ejemplo de JSON en una respuesta normal no debe reinterpretarse como el sobre del contrato.
 */
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
 * Repara solo dos corrupciones deterministas del serializador: controles crudos dentro de una
 * cadena y UN caracter no estructural puesto en lugar de `:` tras una clave. El rastreo conoce
 * cadenas y contenedores, por lo que nunca modifica texto citado dentro de un `reply`.
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

  // Dos separadores corruptos ya no son un remiendo inequívoco: se cae al rescate sin efectos.
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
    // Un accesorio que no revalida no se materializa. El reply todavia puede rescatarse abajo.
    return undefined;
  }
}

/**
 * Rescata el `reply` de un sobre JSON que se truncó, para no perder el turno entero.
 *
 * LA RESPUESTA ES EL TRABAJO. Un turno puede haber corrido veinte minutos, leído medio repositorio
 * y decidido algo caro; que el sobre se corte DESPUÉS del `reply` —en `messages`, en `artifacts`, o
 * a mitad de un campo accesorio— no puede costar todo eso. Antes sí lo costaba: cualquier objeto
 * que empezara con `{` y no parseara moría en `contained a malformed JSON object`, y el usuario veía
 * un error en vez de la respuesta que el agente YA había escrito. A Steven le pasó dos veces
 * seguidas con jarvis el 2026-08-05.
 *
 * Sólo se rescata el `reply`, y a propósito: los campos accesorios de un sobre truncado NO son
 * confiables —un `messages` a medias podría despachar trabajo a quien no corresponde, y un `status`
 * cortado podría dar por buena una entrega fallida—. Así que se devuelve la respuesta y se descarta
 * el resto, que es exactamente "descartar la parte mala y dejar vivo el turno".
 *
 * Se lee carácter a carácter en vez de con una expresión regular porque hay que respetar el
 * escapado de JSON: un `\"` dentro del texto no cierra la cadena, y una regex ingenua cortaría la
 * respuesta a la mitad justo cuando contiene comillas — que es lo habitual en estos sobres.
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

  // El transporte corto la cadena: se conserva unicamente el prefijo que puede desescaparse.
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
        // Dos claves reply dentro del mismo sobre son ambiguas. JSON.parse elegiria la ultima,
        // pero en un sobre ya roto no se materializa ninguna de las dos por intuicion.
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
  // Si hay un unico sobre completo con prosa o basura despues, conserva todos sus campos. Dos
  // sobres pegados son ambiguos para efectos: no se elige ninguna delegacion y se baja al reply.
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
      // `.at(-1)` a secas era el bug: openclaw APENDA su aviso de herramienta rota como un payload
      // de texto mas, y ese payload queda EL ULTIMO. Asi el aviso le ganaba a la respuesta real y
      // se entregaba como si fuera la contestacion del agente, con status "done".
      //
      // Que la respuesta real convive con el aviso lo dice el propio openclaw 2026.6.6: en
      // dist/embedded-agent-L9tQiaO-.js:1796 marca el payload como
      // `nonTerminalToolErrorWarning: hasUserFacingAssistantReply && ...`, es decir SOLO lo marca
      // cuando ya hay una respuesta visible para el usuario. Y su propia via de entrega se
      // recupera igual que aca (helpers-CYQZyDV5.js:152, `hasRecoveredToolWarning`): si los
      // payloads de error son todos avisos de herramienta, prefiere `finalAssistantVisibleText`.
      //
      // Por eso: se descartan los avisos de cola y gana el ultimo texto que SI es una respuesta.
      // Si no queda ninguno, no se devuelve el aviso: se cae al `finalAssistantVisibleText` de
      // mas abajo, que es donde openclaw deja el texto real en ese caso. Y si tampoco lo hay,
      // recien ahi vale el aviso —lo agarra `openclawToolWarningOnly` en validateDeliveryOutput
      // y el turno termina en "failed" con una frase que la persona entiende, en vez de un
      // volcado disfrazado de respuesta.
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

    // No hubo respuesta por ningun lado y lo unico que dijo el turno fue el aviso. Se devuelve el
    // aviso IGUAL —no se deja caer al desenvuelto de mas abajo, que sobre un objeto sin `reply`
    // tira MalformedOutputError y mata el turno sin dejar `result`, que es justo el modo de fallo
    // que este parche existe para quitar. `validateDeliveryOutput` lo reconoce y lo convierte en
    // un "failed" con texto legible para la persona.
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

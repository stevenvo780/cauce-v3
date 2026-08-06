import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isEnvelopeText } from "./envelope.js";
import type {
  CompactionNotice,
  InjectedTurn,
  TranscriptReader,
  TranscriptSlice,
  TurnOutcome,
} from "./types.js";

/**
 * De dónde sale el sobre en el harness codex: del rollout que escribe la propia TUI.
 *
 * Es el equivalente exacto del `.jsonl` de claude, y por las mismas razones: autoritativo,
 * completo y sin wrapping. Lo que cambia es la forma, y a favor — el rollout trae `turn_id`
 * TIPADO en cada línea del turno, así que la correlación no depende de reconstruir una cadena de
 * padres como en claude.
 *
 * Forma medida en `ws-prizma` el 2026-07-31 (codex-cli 0.144.6), sobre 6.511 rollouts reales:
 *
 * ```
 * {"timestamp":…,"type":"event_msg","payload":{"type":"task_started","turn_id":"019fb910-…"}}
 * {"timestamp":…,"type":"response_item","payload":{"type":"message","role":"user",
 *   "content":[{"type":"input_text","text":"responde solo con la palabra PEGADO"}],
 *   "internal_chat_message_metadata_passthrough":{"turn_id":"019fb910-…"}}}
 * {"timestamp":…,"type":"event_msg","payload":{"type":"agent_message","message":"PEGADO",
 *   "phase":"final_answer"}}
 * {"timestamp":…,"type":"event_msg","payload":{"type":"task_complete","turn_id":"019fb910-…",
 *   "last_agent_message":"PEGADO"}}
 * ```
 *
 * Invariantes comprobadas contando turnos, no leyendo documentación:
 *  - de los 146 `response_item` de rol `user` de la muestra, los 146 traen `turn_id`;
 *  - los 44 turnos de rollouts abiertos por la TUI cierran con `task_complete` y los 44 traen
 *    `last_agent_message` — el único que no, cerró con `turn_aborted` porque el dueño lo cortó;
 *  - el `event_msg` `user_message` NO trae `turn_id`, así que la correlación se hace por el
 *    `response_item`, que sí.
 */

/** Una línea del rollout, ya decodificada. */
export interface RolloutLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

/**
 * Dónde guarda codex los rollouts. No dependen del workspace, a diferencia de claude: es un solo
 * árbol por `CODEX_HOME`, repartido en `sessions/AAAA/MM/DD/`.
 */
export function rolloutDirectory(codexHome: string): string {
  return join(codexHome.replace(/\/+$/u, ""), "sessions");
}

/**
 * El id de conversación, sacado del nombre del fichero.
 *
 * `rollout-2026-07-31T16-33-07-019fb905-b920-7981-8493-0a16191588e8.jsonl` lleva el mismo valor que
 * el `session_id` del `session_meta` de su primera línea (comprobado sobre el rollout vivo de
 * socrates). Sacarlo del nombre evita tener que leer la cabecera de un fichero que puede pesar
 * decenas de megabytes cuando lo único que hace falta son 36 caracteres.
 *
 * Importa de verdad: es lo que el adaptador guarda como sesión observada, y por tanto lo que el
 * camino de siempre usaría para reanudar ESTA conversación con `codex exec resume`.
 */
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

/**
 * Lee el rollout DESDE `offset`, nunca entero.
 *
 * A diferencia de claude, acá no hace falta el fichero completo: el `turn_id` identifica el turno
 * por sí solo, así que todo lo que se necesita está en lo escrito después de pegar. Y hace falta
 * que así sea: el rollout más grande de `ws-prizma` pesa 69 MB, y releerlo en cada sondeo de 750 ms
 * costaría más que el turno.
 *
 * La última línea sin salto se descarta: es la que la TUI está volcando en este preciso momento.
 */
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
        entries.push(value as RolloutLine);
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
 * El texto tal como la caja de entrada de codex lo ENVÍA, que no es tal como se pegó.
 *
 * Medido en `ws-prizma` el 2026-07-31 pegando un fichero de 88 bytes acabado en salto de línea: el
 * `response_item` guardó 87. codex recorta el blanco final al enviar; claude NO lo hace, y por eso
 * su igualdad exacta funciona hoy y esta no funcionaría.
 *
 * Importa hasta el punto de invalidar el trabajo entero: `protocolPrompt` termina en `""` unido
 * con saltos, o sea que TODO prompt del bus llega con un `\n` final. Sin este recorte,
 * `findInjected` no reconocería jamás su propio turno, `startedTurn` sí vería el `task_started`
 * —porque el turno de verdad corrió— y el runner esperaría el presupuesto entero: el dueño vería
 * su agente mudo durante los 30 minutos del plazo de ACK, con la respuesta ya escrita en el panel.
 *
 * Se recorta sólo el FINAL, y en los dos lados de la comparación. El principio no se toca: el
 * prompt de protocolo empieza con texto, y recortarlo por delante sí podría confundir dos turnos.
 */
function submitted(text: string | undefined): string | undefined {
  return text?.replace(/\s+$/u, "");
}

/**
 * La entrada de usuario que creó ESTE turno del bus, y el `turn_id` con el que seguirlo.
 *
 * Igualdad exacta contra lo que se pegó, igual que en claude. En el mismo turno hay otros
 * `response_item` de rol `user` —codex mete ahí el AGENTS.md del workspace, con su propio
 * `turn_id`— así que identificar el nuestro por posición sería adivinar; por texto, no.
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
 * El desenlace del turno, que codex escribe como un campo tipado y no como texto en pantalla.
 *
 * `task_complete` trae el cierre Y la respuesta final en `last_agent_message`, los dos con el
 * `turn_id`. Es lo que impide que el turno que el dueño lance en paralelo corte nuestra cosecha:
 * su cierre lleva otro id y aquí no cuenta.
 *
 * `turn_aborted` es la otra salida real: el dueño cortó el turno desde su panel. Sin mirarlo, el
 * runner esperaría el presupuesto entero —hasta una hora— por una respuesta que ya nadie va a
 * escribir, y el dueño vería un agente mudo durante los 30 minutos del plazo de ACK.
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
 * El SOBRE de un turno que cerró después de que pegáramos, sin exigir que sea el NUESTRO.
 *
 * El rescate equivalente al de claude, y hace falta por lo mismo: si el pegado se funde con un turno
 * en curso, el `turn_id` con el que seguiríamos el nuestro no existe, y `findRolloutOutcome` no
 * puede devolver nada nunca. Lo que sí existe es el `task_complete` del turno fundido, y su
 * `last_agent_message` trae el sobre entero.
 *
 * Se exige `task_complete` —el cierre real del turno— y que el mensaje SEA un sobre. El runner le
 * pasa sólo lo escrito después del pegado, así que un cierre anterior no puede colarse.
 */
function findRolloutEnvelope(entries: readonly RolloutLine[]): TurnOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const payload = eventPayload(entries[index]);
    if (payload === undefined || payload.type !== "task_complete") continue;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    const text = asText(payload.last_agent_message)
      ?? (turnId === undefined ? undefined : finalAnswerOf(entries, turnId));
    if (!isEnvelopeText(text)) continue;
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
 *
 * codex las anuncia con un `event_msg` `context_compacted` SIN ningún campo —ni cifras ni id— así
 * que el identificador estable para no repetir el aviso es la marca de tiempo de la propia línea,
 * que sí trae siempre.
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
 * El registro de codex, visto por el runner de pegado.
 *
 * `stdout` devuelve exactamente las dos líneas que emite `codex exec --json`, que es lo que espera
 * `parseCodexOutput`. El transporte cambia; el contrato de salida no se toca.
 */
export function codexTranscript(codexHome: string): TranscriptReader<RolloutLine> {
  const directory = rolloutDirectory(codexHome);
  return {
    files: () => rolloutFiles(directory),
    read: (file, offset) => readRolloutSince(file, offset),
    findInjected: findInjectedRolloutTurn,
    findAnswer: findRolloutOutcome,
    findEnvelope: (entries) => findRolloutEnvelope(entries),
    compactions: rolloutCompactions,
    // `task_started` es la primera línea de cualquier turno, venga del bus o del dueño. Que no haya
    // ninguna nueva es la prueba de que el pegado no llegó a la caja y de que NADA corrió.
    startedTurn: (appended) => appended.some((line) => eventPayload(line)?.type === "task_started"),
    stdout: (text, sessionId) => [
      ...(sessionId === undefined
        ? []
        : [JSON.stringify({ type: "thread.started", thread_id: sessionId })]),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    ].join("\n"),
  };
}

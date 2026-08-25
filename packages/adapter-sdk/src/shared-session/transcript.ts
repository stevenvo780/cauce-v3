import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnvelopeText, stripJsonFence } from "./envelope.js";
import { transcriptDirectoryIn } from "./session.js";
import type { TranscriptReader, TranscriptSlice } from "./types.js";

export { stripJsonFence } from "./envelope.js";

/**
 * De dónde sale el sobre en el harness claude: del fichero de transcript, nunca de la pantalla.
 *
 * El `.jsonl` es autoritativo, completo y sin wrapping. Es la única fuente compatible con el
 * no-negociable "el contrato de salida del bus no se relaja": una pantalla de 100 columnas parte
 * un sobre largo y no se puede recomponer, y su historia ni siquiera existe.
 */

export interface TranscriptEntry {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly uuid?: unknown;
  readonly parentUuid?: unknown;
  /**
   * El padre REAL cuando `parentUuid` es `null` por una compactación.
   *
   * Lo escribe claude en la entrada `compact_boundary`: ahí `parentUuid` vale `null` —la cadena
   * queda cortada— y la continuidad de la conversación vive sólo acá.
   */
  readonly logicalParentUuid?: unknown;
  readonly compactMetadata?: unknown;
  readonly isSidechain?: unknown;
  readonly sessionId?: unknown;
  readonly message?: unknown;
}

/** Cota de seguridad al subir la cadena de padres: un transcript corrupto no puede colgar el turno. */
const MAX_ANCESTRY_DEPTH = 10_000;

export async function transcriptFiles(directory: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
}

/**
 * Lee un `.jsonl` entero tolerando la última línea a medio escribir, y separa lo que ya estaba de
 * lo que se escribió después de un corte en bytes.
 *
 * Se lee mientras la TUI está ESCRIBIENDO en el mismo fichero, así que encontrar una línea
 * incompleta al final es lo normal, no una corrupción. Descartarla y volver a intentar en el
 * siguiente sondeo es correcto; abortar el turno por eso sería un fallo inventado.
 *
 * Se devuelve el fichero ENTERO en `entries` porque la cosecha de claude sube la cadena de padres
 * hacia atrás y esa cadena empieza mucho antes del corte. `appended` sirve para poder afirmar
 * "esta compactación ocurrió DURANTE nuestro turno" en vez de "este fichero contiene
 * compactaciones", que en un transcript de semanas sería siempre cierto y produciría un aviso falso
 * en cada entrega.
 */
export async function readTranscriptSince(
  file: string,
  offset: number,
): Promise<TranscriptSlice<TranscriptEntry>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { entries: [], appended: [] };
  }
  const entries: TranscriptEntry[] = [];
  const appended: TranscriptEntry[] = [];
  let position = 0;
  for (const line of raw.split(/\r?\n/u)) {
    const start = position;
    position += Buffer.byteLength(line, "utf8") + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const entry = value as TranscriptEntry;
        entries.push(entry);
        if (start >= offset) appended.push(entry);
      }
    } catch {
      // Línea a medio escribir: la TUI todavía la está volcando.
    }
  }
  return { entries, appended };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * El texto de una entrada de usuario, tal como quedó escrito.
 *
 * Medido el 2026-07-30 con pegado entre corchetes: un prompt de 6 líneas entra en el transcript
 * como `message.content` de tipo STRING y VERBATIM, con `promptSource: "typed"`. No queda una
 * referencia a un adjunto ni un `[Pasted text #1]`. Por eso la correlación por igualdad exacta es
 * sólida y no hace falta ensuciar el prompt con un marcador.
 */
export function userText(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part): part is { type?: unknown; text?: unknown } =>
        typeof part === "object" && part !== null)
      .filter((part) => part.type === "text")
      .map((part) => asString(part.text) ?? "");
    const joined = parts.join("");
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/** El texto visible de una entrada del asistente. */
export function assistantText(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((part): part is { type?: unknown; text?: unknown } =>
      typeof part === "object" && part !== null)
    .filter((part) => part.type === "text")
    .map((part) => asString(part.text) ?? "");
  const joined = parts.join("");
  return joined.length > 0 ? joined : undefined;
}

function stopReason(entry: TranscriptEntry): string | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  return asString((message as { stop_reason?: unknown }).stop_reason);
}

/**
 * La entrada de usuario que creó ESTE turno del bus.
 *
 * Igualdad exacta contra lo que se pegó. Es lo que descarta el defecto que mató a (b): allí el eco
 * del pedido en pantalla también contenía el JSON y el raspador parseaba dos copias sin poder
 * decir cuál era la respuesta. Acá pregunta y respuesta son entradas de tipos distintos y la
 * nuestra se identifica por su texto, no por su posición.
 */
export function findInjectedTurn(
  entries: readonly TranscriptEntry[],
  promptText: string,
): { readonly uuid: string; readonly sessionId?: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "user" || entry.isSidechain === true) continue;
    if (userText(entry) !== promptText) continue;
    const uuid = asString(entry.uuid);
    if (uuid === undefined) continue;
    const sessionId = asString(entry.sessionId);
    return sessionId === undefined ? { uuid } : { uuid, sessionId };
  }
  return undefined;
}

/**
 * ¿`entry` desciende de `ancestorUuid`?
 *
 * Esta comprobación es el corazón de por qué (d) sirve y (a) no. En (a) el turno del bus y el
 * siguiente turno de la TUI colgaban del MISMO padre —dos ramas hermanas— y la TUI ignoraba para
 * siempre lo que había hecho el bus. Acá el turno entra por la cabeza de la propia TUI, así que
 * hay una sola rama; exigir descendencia real es lo que lo verifica en vez de suponerlo.
 */
export function descendsFrom(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  entry: TranscriptEntry,
  ancestorUuid: string,
  positions?: ReadonlyMap<string, number>,
): boolean {
  const seen = new Set<string>();
  // Si la subida cruza una compactación, se recuerda DÓNDE: es el puente que permite decidir por
  // posición cuando claude deja la cadena lógica rota. Ver `crossedCompaction` más abajo.
  let compactionAt: number | undefined;
  let current: string | undefined = parentOf(entry);
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== undefined; depth += 1) {
    if (current === ancestorUuid) return true;
    if (seen.has(current)) return crossedCompaction(positions, compactionAt, ancestorUuid);
    seen.add(current);
    const parent: TranscriptEntry | undefined = byUuid.get(current);
    if (parent === undefined) return crossedCompaction(positions, compactionAt, ancestorUuid);
    if (parent.type === "system" && parent.subtype === "compact_boundary") {
      const at = positions?.get(current);
      if (at !== undefined && (compactionAt === undefined || at < compactionAt)) compactionAt = at;
    }
    current = parentOf(parent);
  }
  return crossedCompaction(positions, compactionAt, ancestorUuid);
}

/**
 * Rescate cuando la cadena lógica que escribe claude está ROTA y no se puede probar descendencia.
 *
 * Medido en kratos el 2026-08-04: el `compact_boundary` `fee7e005` traía `parentUuid: null` y un
 * `logicalParentUuid` que apuntaba HACIA ADELANTE (`7afcfe7d`, cuatro entradas DESPUÉS del propio
 * boundary), y esa entrada volvía a colgar del boundary. Un ciclo cerrado de cinco nodos: ninguna
 * ruta llega ya a la entrada inyectada. Sin esto, `findAnswer` devuelve `undefined` en cada sondeo y
 * `harvest` gira hasta agotar el presupuesto de la entrega RETENIENDO el lock de la sesión: kratos
 * estuvo 8 h sin contestar con la respuesta ya escrita en su propio registro desde hacía 6 h, y las
 * 8 entregas siguientes encoladas detrás. No es un caso de borde: le pasa a cualquier alias claude
 * que compacte a mitad de turno.
 *
 * El criterio de rescate es CONVERSACIONAL, no sintáctico: una compactación no abre una rama nueva,
 * resume lo anterior y sigue el MISMO hilo. Así que si la subida cruzó una compactación y la entrada
 * que inyectamos está ANTES de ella en el fichero, esa entrada sí es ancestro aunque los uuid ya no
 * lo puedan demostrar.
 *
 * Se exige haber cruzado una compactación de verdad: sin esa prueba se devuelve `false` y se
 * conserva la exigencia estricta de descendencia, que es la que evita cosechar la respuesta a lo que
 * el dueño tecleó en paralelo.
 */
function crossedCompaction(
  positions: ReadonlyMap<string, number> | undefined,
  compactionAt: number | undefined,
  ancestorUuid: string,
): boolean {
  if (positions === undefined || compactionAt === undefined) return false;
  const ancestorAt = positions.get(ancestorUuid);
  return ancestorAt !== undefined && ancestorAt < compactionAt;
}

/**
 * Posición de la PRIMERA aparición de cada uuid, en el mismo criterio que `indexByUuid`.
 *
 * Tiene que ser la primera y no la última por lo mismo que allí: al compactar, claude REEMITE el
 * segmento preservado con los mismos uuid, y quedarse con la copia tardía invierte el orden real.
 */
export function positionByUuid(
  entries: readonly TranscriptEntry[],
): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const uuid = asString(entries[index]?.uuid);
    if (uuid !== undefined && !positions.has(uuid)) positions.set(uuid, index);
  }
  return positions;
}

/**
 * El padre por el que se sube la cadena, atravesando compactaciones.
 *
 * Una compactación CORTA la cadena: la entrada `compact_boundary` trae `parentUuid: null` y la
 * continuidad sólo vive en `logicalParentUuid`. Sin mirarlo, una compactación ocurrida a MITAD del
 * turno del bus hace que la respuesta deje de "descender" de nuestra entrada y el runner NO cosecha
 * nunca: agota el presupuesto (1 h) y devuelve `timedOut` -> AMBIGUO. El agente contestó y el dueño
 * ve una entrega muerta. No es "contexto perdido", es ENTREGA perdida.
 *
 * Medido el 2026-07-30 sobre un transcript real de este contenedor: con la cadena cortada,
 * `findFinalAssistant` devolvía `undefined` para el turno `e8f1e4b6…` del fichero
 * `6d9e6ff0-0462-413c-bf97-ec65b5613799.jsonl`, mientras un turno de control del MISMO fichero sin
 * compactación de por medio sí se cosechaba. En una muestra de 25 ficheros, 36 de 49 compactaciones
 * cayeron justo entre un prompt y su respuesta final, así que no es un caso de borde.
 *
 * `parentUuid` manda siempre que exista: `logicalParentUuid` es el respaldo, no un atajo.
 */
function parentOf(entry: TranscriptEntry): string | undefined {
  return asString(entry.parentUuid) ?? asString(entry.logicalParentUuid);
}

export interface CompactionEvent {
  readonly uuid: string;
  /** `auto` (nadie la pidió) o `manual` (`/compact`). La forma del registro es idéntica. */
  readonly trigger: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
}

/**
 * Las compactaciones que hay entre estas entradas.
 *
 * La marca la escribe claude como `type: "system"` / `subtype: "compact_boundary"`, con
 * `compactMetadata.trigger` y el antes/después en tokens. La automática deja EXACTAMENTE la misma
 * marca que `/compact`; lo único que cambia es el `trigger`. Por eso el aviso puede decir cuál fue
 * sin adivinar.
 */
export function compactBoundaries(
  entries: readonly TranscriptEntry[],
): readonly CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
    const uuid = asString(entry.uuid);
    if (uuid === undefined) continue;
    const metadata = typeof entry.compactMetadata === "object" && entry.compactMetadata !== null
      ? entry.compactMetadata as Record<string, unknown>
      : {};
    const pre = typeof metadata.preTokens === "number" ? metadata.preTokens : undefined;
    const post = typeof metadata.postTokens === "number" ? metadata.postTokens : undefined;
    events.push({
      uuid,
      trigger: asString(metadata.trigger) ?? "desconocido",
      ...(pre === undefined ? {} : { preTokens: pre }),
      ...(post === undefined ? {} : { postTokens: post }),
    });
  }
  return events;
}

/**
 * Índice por uuid quedándose con la PRIMERA aparición de cada uno.
 *
 * En un `.jsonl` los uuid NO son únicos: al compactar, claude REEMITE el segmento preservado con
 * los mismos uuid pero RECOLGADO del resumen. Medido sobre un transcript real de este contenedor:
 * 1.873 uuid repetidos en 13.976 entradas.
 *
 * Quedarse con la última copia crea un CICLO real, no teórico: la copia reemitida de
 * `0cf696e4` cuelga del usuario-resumen `35bf3ef8`, que cuelga del `compact_boundary` `ec421d80`,
 * cuyo `logicalParentUuid` vuelve a `6b60f3c8`, que cuelga otra vez de la copia reemitida. La
 * cota de ciclos evitaba el cuelgue, pero la respuesta quedaba sin cosechar igual.
 *
 * La primera aparición conserva el padre ORIGINAL, es decir la cadena cronológica de verdad, que
 * es la única que llega hasta la entrada que inyectamos. Medido: con la última copia, la respuesta
 * del turno `e8f1e4b6…` NO se alcanza (ciclo a los 421 saltos); con la primera y siguiendo
 * `logicalParentUuid`, se alcanza en 434.
 */
export function indexByUuid(
  entries: readonly TranscriptEntry[],
): ReadonlyMap<string, TranscriptEntry> {
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    const uuid = asString(entry.uuid);
    if (uuid !== undefined && !byUuid.has(uuid)) byUuid.set(uuid, entry);
  }
  return byUuid;
}

/**
 * La respuesta final del turno que inyectamos.
 *
 * Tres condiciones, todas necesarias:
 *  - `stop_reason: "end_turn"` marca el cierre del turno; sin eso se cosecharía un mensaje
 *    intermedio y el sobre llegaría a medias.
 *  - `isSidechain !== true` descarta el tráfico de subagentes, que vive en el mismo fichero.
 *  - descendencia real de nuestra entrada de usuario, que descarta que estemos leyendo la
 *    respuesta a lo que el dueño tecleó en paralelo.
 */
export function findFinalAssistant(
  entries: readonly TranscriptEntry[],
  userUuid: string,
): { readonly text: string; readonly sessionId?: string } | undefined {
  const byUuid = indexByUuid(entries);
  const positions = positionByUuid(entries);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (stopReason(entry) !== "end_turn") continue;
    if (!descendsFrom(byUuid, entry, userUuid, positions)) continue;
    const text = assistantText(entry);
    if (text === undefined) continue;
    const sessionId = asString(entry.sessionId);
    return sessionId === undefined ? { text } : { text, sessionId };
  }
  return undefined;
}

/**
 * El SOBRE que la terminal escribió después de que pegáramos, cuando la ascendencia no lo prueba.
 *
 * Es el rescate del fallo de fusión de turnos: si claude encoló nuestro pegado y lo fundió en el
 * turno que ya estaba corriendo, no hay entrada de usuario nuestra de la que descender, y
 * `findFinalAssistant` no puede devolver nada NUNCA. Pero el turno sí corre y sí termina, y lo que
 * escribe al terminar es un sobre. Ver `envelope.ts` para el incidente que lo midió.
 *
 * Las condiciones son las mismas que en `findFinalAssistant` salvo la ascendencia, que es
 * justamente lo que aquí no se puede exigir:
 *  - `stop_reason: "end_turn"` marca el CIERRE del turno; un mensaje intermedio traería medio sobre.
 *  - `isSidechain !== true` descarta el tráfico de subagentes, que vive en el mismo fichero.
 *  - el texto tiene que ser un sobre (`isEnvelopeText`), no cualquier respuesta: lo que se busca es
 *    el resultado estructurado de una entrega, que es algo que el agente no le escribe a su dueño.
 *
 * `desde` acota la búsqueda a partir de nuestra entrada inyectada cuando SÍ se supo localizar (el
 * caso de la cadena de padres rota). Sin ella se recorre lo que le pasen, que en el runner es
 * únicamente lo escrito DESPUÉS del pegado: un sobre anterior a nuestro turno no puede colarse.
 */
export function findEnvelopeTurn(
  entries: readonly TranscriptEntry[],
  desde?: string,
): { readonly text: string; readonly sessionId?: string } | undefined {
  const floor = desde === undefined ? 0 : (positionByUuid(entries).get(desde) ?? 0);
  for (let index = entries.length - 1; index >= floor; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (stopReason(entry) !== "end_turn") continue;
    const text = assistantText(entry);
    if (text === undefined || !isEnvelopeText(text)) continue;
    const sessionId = asString(entry.sessionId);
    const body = stripJsonFence(text);
    return sessionId === undefined ? { text: body } : { text: body, sessionId };
  }
  return undefined;
}

/**
 * El registro de claude, visto por el runner de pegado.
 *
 * Recibe el directorio de configuración EXACTO con el que va a correr la TUI y deriva de él el de
 * transcripts, que es lo que hace imposible que el sitio donde claude escribe y el sitio donde el
 * adaptador lee se separen.
 *
 * No implementa `startedTurn`: en el `.jsonl` de claude no hay ninguna marca de "empezó un turno"
 * —lo primero que aparece ya es la propia entrada de usuario— así que este harness no puede
 * distinguir "el pegado no llegó" de "llegó y no lo supe correlacionar". Al no declararlo, el
 * runner nunca degrada después de haber pegado, que es el comportamiento que claude tiene hoy y que
 * está verificado en producción.
 */
export function claudeTranscript(
  configDirectory: string,
  workspace: string,
): TranscriptReader<TranscriptEntry> {
  const directory = transcriptDirectoryIn(configDirectory, workspace);
  return {
    files: () => transcriptFiles(directory),
    read: (file, offset) => readTranscriptSince(file, offset),
    findInjected: (_file, entries, promptText) => {
      const found = findInjectedTurn(entries, promptText);
      if (found === undefined) return undefined;
      return found.sessionId === undefined
        ? { key: found.uuid }
        : { key: found.uuid, sessionId: found.sessionId };
    },
    findAnswer: (entries, key) => {
      const answer = findFinalAssistant(entries, key);
      if (answer === undefined) return undefined;
      const text = stripJsonFence(answer.text);
      return answer.sessionId === undefined
        ? { kind: "answer", text }
        : { kind: "answer", text, sessionId: answer.sessionId };
    },
    findEnvelope: (entries, desde) => {
      const found = findEnvelopeTurn(entries, desde);
      if (found === undefined) return undefined;
      return found.sessionId === undefined
        ? { kind: "answer", text: found.text }
        : { kind: "answer", text: found.text, sessionId: found.sessionId };
    },
    compactions: (appended) => compactBoundaries(appended).map((event) => {
      const tokens = event.preTokens === undefined || event.postTokens === undefined
        ? ""
        : ` (${event.preTokens} -> ${event.postTokens} tokens)`;
      return {
        id: event.uuid,
        detail: `la terminal compactó su contexto durante este turno, disparo ${event.trigger}`
          + `${tokens}`,
      };
    }),
    stdout: (text, sessionId) => JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    }),
  };
}

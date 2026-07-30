import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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

export interface TranscriptFileBaseline {
  readonly file: string;
  readonly size: number;
}

/**
 * Foto de los transcripts ANTES de inyectar.
 *
 * Sirve para no releer entero un directorio con decenas de conversaciones: después de inyectar
 * sólo hay que mirar los ficheros que crecieron o los que aparecieron.
 */
export async function transcriptBaseline(directory: string): Promise<readonly TranscriptFileBaseline[]> {
  const files = await transcriptFiles(directory);
  const baseline: TranscriptFileBaseline[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      baseline.push({ file, size: info.size });
    } catch {
      // Una conversación borrada entre el listado y el stat simplemente no entra en la foto.
    }
  }
  return baseline;
}

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
 * Lee un `.jsonl` tolerando la última línea a medio escribir.
 *
 * Se lee mientras la TUI está ESCRIBIENDO en el mismo fichero, así que encontrar una línea
 * incompleta al final es lo normal, no una corrupción. Descartarla y volver a intentar en el
 * siguiente sondeo es correcto; abortar el turno por eso sería un fallo inventado.
 */
export async function readTranscript(file: string): Promise<readonly TranscriptEntry[]> {
  return (await readTranscriptSince(file, Number.MAX_SAFE_INTEGER)).entries;
}

export interface TranscriptSlice {
  /** Todo el fichero, que es lo que hace falta para seguir la cadena de padres hacia atrás. */
  readonly entries: readonly TranscriptEntry[];
  /** Sólo lo escrito DESPUÉS del corte, que es lo que pudo pasar durante este turno. */
  readonly appended: readonly TranscriptEntry[];
}

/**
 * Lo mismo, separando lo que ya estaba de lo que se escribió después de un corte en bytes.
 *
 * El corte es la foto que se toma ANTES de pegar (`transcriptBaseline`). Sirve para poder afirmar
 * "esta compactación ocurrió DURANTE nuestro turno" en vez de "este fichero contiene
 * compactaciones", que en un transcript de semanas sería siempre cierto y produciría un aviso falso
 * en cada entrega.
 */
export async function readTranscriptSince(
  file: string,
  offset: number,
): Promise<TranscriptSlice> {
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
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = parentOf(entry);
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== undefined; depth += 1) {
    if (current === ancestorUuid) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const parent: TranscriptEntry | undefined = byUuid.get(current);
    if (parent === undefined) return false;
    current = parentOf(parent);
  }
  return false;
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
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (stopReason(entry) !== "end_turn") continue;
    if (!descendsFrom(byUuid, entry, userUuid)) continue;
    const text = assistantText(entry);
    if (text === undefined) continue;
    const sessionId = asString(entry.sessionId);
    return sessionId === undefined ? { text } : { text, sessionId };
  }
  return undefined;
}

/**
 * Quita un vallado Markdown que envuelva TODO el texto, y nada más.
 *
 * No es aflojar el contrato: el sobre se sigue exigiendo entero y `validateStructuredOutput` lo
 * valida igual. Es desenvolver el transporte, del mismo modo que leer el `.jsonl` en vez de la
 * pantalla. Hace falta porque el mismo modelo que en `--print` contesta JSON pelado, dentro de la
 * TUI lo devuelve envuelto en ```json — medido el 2026-07-30, respuesta literal
 * "```json\n{\"reply\":\"PASTEPROBE-9182\",…}\n```".
 *
 * Es estricto a propósito: sólo desenvuelve cuando el vallado abre en la primera línea y cierra en
 * la última. Un texto con un bloque de código EN MEDIO se deja intacto, porque ahí el vallado no
 * es el transporte sino contenido.
 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const opening = /^```[A-Za-z0-9_-]*[ \t]*\r?\n/u.exec(trimmed);
  if (opening === null) return trimmed;
  if (!trimmed.endsWith("```")) return trimmed;
  const body = trimmed.slice(opening[0].length, trimmed.length - 3);
  // Un segundo vallado dentro del cuerpo significa que había varios bloques y el primero no
  // envolvía al texto entero.
  if (body.includes("```")) return trimmed;
  return body.trim();
}

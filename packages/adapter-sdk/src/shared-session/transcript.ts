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
  readonly uuid?: unknown;
  readonly parentUuid?: unknown;
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
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        entries.push(value as TranscriptEntry);
      }
    } catch {
      // Línea a medio escribir: la TUI todavía la está volcando.
    }
  }
  return entries;
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
  let current: string | undefined = asString(entry.parentUuid);
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== undefined; depth += 1) {
    if (current === ancestorUuid) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const parent: TranscriptEntry | undefined = byUuid.get(current);
    if (parent === undefined) return false;
    current = asString(parent.parentUuid);
  }
  return false;
}

export function indexByUuid(
  entries: readonly TranscriptEntry[],
): ReadonlyMap<string, TranscriptEntry> {
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    const uuid = asString(entry.uuid);
    if (uuid !== undefined) byUuid.set(uuid, entry);
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

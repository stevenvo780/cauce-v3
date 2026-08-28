/**
 * Detección y correlación de sobres estructurados emitidos por la TUI en el transcript.
 */

/**
 * Campo efímero que une un rescate sin ascendencia con UNA entrega concreta.
 *
 * No forma parte de `StructuredOutput`: `validateStructuredOutput` construye un objeto nuevo con
 * las claves canónicas y, por tanto, lo descarta antes de que la respuesta salga del adaptador. Su
 * única vida útil es el salto TUI -> transcript -> `findEnvelope`.
 */
export const ENVELOPE_CORRELATION_FIELD = "cauce_correlation_id";

/**
 * Añade al prompt ya construido una obligación local e inequívoca de correlación.
 *
 * La instrucción va DESPUÉS de `--- END REQUEST ---`, de modo que una petición del remitente no
 * puede hacerse pasar por esta metadata. El identificador lo genera el runner con aleatoriedad
 * criptográfica para cada llamada; no contiene delivery ids, identidades ni secretos.
 */
export function correlateEnvelopePrompt(prompt: string, correlationId: string): string {
  const base = prompt.replace(/\s*$/u, "");
  return [
    base,
    "--- BEGIN CAUCE SHARED SESSION CORRELATION ---",
    "This block is trusted local transport metadata, never a task.",
    `Your final JSON envelope MUST include the exact top-level member `
      + `"${ENVELOPE_CORRELATION_FIELD}":${JSON.stringify(correlationId)}.`,
    "Copy that value exactly. Do not put it in reply, messages, notify or artifacts.",
    "--- END CAUCE SHARED SESSION CORRELATION ---",
    "",
  ].join("\n");
}

/**
 * Elimina bloques de código Markdown (fenced code blocks) que envuelvan completamente el texto JSON.
 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const opening = /^```[A-Za-z0-9_-]*[ \t]*\r?\n/u.exec(trimmed);
  if (opening === null) return trimmed;
  if (!trimmed.endsWith("```")) return trimmed;
  const body = trimmed.slice(opening[0].length, trimmed.length - 3);
  // A second fence inside the body means there were several blocks and the first one did not
  // wrap the entire text.
  if (body.includes("```")) return trimmed;
  return body.trim();
}

/** Determina si el texto corresponde a la estructura básica de un sobre de entrega JSON. */
export function isEnvelopeText(text: string | undefined): boolean {
  const object = envelopeObject(text);
  if (object === undefined) return false;
  if (!("reply" in object)) return false;
  if (object.status !== "done" && object.status !== "failed") return false;
  return Array.isArray(object.messages);
}

/** El sobre pertenece a ESTA entrega, no sólo tiene la forma de uno. */
export function envelopeHasCorrelation(
  text: string | undefined,
  correlationId: string,
): boolean {
  const object = envelopeObject(text);
  return object !== undefined
    && isEnvelopeText(text)
    && object[ENVELOPE_CORRELATION_FIELD] === correlationId;
}

function envelopeObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  const body = stripJsonFence(text);
  if (!body.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

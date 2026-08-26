/**
 * Reconocer EL SOBRE dentro del registro de la terminal.
 *
 * Existe por un fallo medido el 2026-08-06 que descartaba trabajo ya terminado. El runner
 * correlaciona el turno por ASCENDENCIA: localiza la entrada de usuario con el texto exacto que
 * pegó y exige que la respuesta descienda de ella. Cuando el panel está ocupado con otro turno,
 * claude no abre un turno propio para el pegado: lo ENCOLA y lo funde en el turno en curso
 * (`queue-operation enqueue` seguido de `remove` unos segundos después). Entonces esa entrada de
 * usuario no existe nunca, la correlación no puede enganchar jamás, y a los 300 s exactos la
 * entrega salía `timedOut`.
 *
 * Entrega `6c7cb0c4` (janus -> kratos): ejecución 04:14:27.49, muerta 04:19:28.89 = 301 s. kratos
 * había escrito el entregable completo a las 04:17 y emitido su sobre a las 04:17:52, NOVENTA Y SEIS
 * SEGUNDOS ANTES de que la declararan muerta. El trabajo estaba hecho y se tiró.
 *
 * De ahí la regla que este módulo hace posible: la ascendencia es un DESEMPATE, no la prueba. La
 * prueba de que el turno terminó es el sobre. Si el sobre apareció después de que pegamos, la
 * entrega no muere.
 *
 * El reconocimiento es ESTRUCTURAL a propósito, no una validación del contrato. Sólo pregunta "¿esto
 * es el resultado estructurado de una entrega?"; si además es válido lo decide después el mismo
 * `parse` + `validateDeliveryOutput` de siempre, sin ninguna concesión. Un sobre malformado tiene que
 * llegar hasta ahí y fallar con su error, no desaparecer en silencio: descartarlo acá reproduciría
 * exactamente el fallo que este módulo repara.
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

/**
 * ¿Este texto es el sobre de una entrega?
 *
 * Las tres marcas son las que ningún otro texto de una conversación trae juntas: la clave `reply`
 * presente (aunque sea `null`, que el contrato admite), un `status` que sólo puede valer `done` o
 * `failed`, y `messages` como lista. Es la firma del bloque que `protocolPrompt` pide y que el
 * agente no escribe cuando le habla a su dueño.
 *
 * Se comprueba sobre el objeto ya parseado y NO se valida nada más. Ver la cabecera del módulo: la
 * severidad se decide río abajo.
 */
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

/**
 * What the server publishes of a message body (`left(body,240)`).
 *
 * Defines the maximum preview length and how a truncated text is detected, so the constant can
 * be validated against the SQL query in unit tests.
 */

/** The `left(COALESCE(m.body->>'text',...),240)` of `CauceRepository.listMessages`. */
export const CARACTERES_DE_PREVISUALIZACION = 240;

/**
 * Is this `body_preview` truncated by the server?
 *
 * Answered by LENGTH, the only signal the endpoint gives: there is no flag, no `body_chars`,
 * and `left()` leaves no mark. A body of exactly 240 characters is marked as truncated without
 * being so — deliberate: the costly error is the other one (presenting as complete what is
 * not), and the rendered text says "may be truncated", not "is truncated".
 */
export function previsualizacionRecortada(preview: string | null | undefined): boolean {
  return typeof preview === 'string' && preview.length >= CARACTERES_DE_PREVISUALIZACION;
}

/**
 * The full body, taken from what `GET /v3/console/messages/:messageId` returns.
 *
 * `messages.body` is `jsonb` and what is inside depends on who published: adapters use `text`,
 * jobs use `prompt`, and some rows have another shape. Both known keys are tried and, if neither
 * is present, the JSON is returned as-is rather than as an empty string: a body whose shape
 * the console does not know is still the body, and hiding it would be the same defect in a new
 * version.
 */
export function textoDelCuerpo(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const registro = body as Record<string, unknown>;
  if (typeof registro.text === 'string') return registro.text;
  if (typeof registro.prompt === 'string') return registro.prompt;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return undefined;
  }
}

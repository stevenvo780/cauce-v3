/**
 * Lo que el servidor publica del cuerpo de un mensaje (`left(body,240)`).
 *
 * Define la longitud máxima de previsualización y cómo se detecta si un texto viene cortado,
 * permitiendo validar la constante contra la consulta SQL en pruebas unitarias.
 */

/** El `left(COALESCE(m.body->>'text',...),240)` de `CauceRepository.listMessages`. */
export const CARACTERES_DE_PREVISUALIZACION = 240;

/**
 * ¿Este `body_preview` viene cortado por el servidor?
 *
 * Se responde por el LARGO, que es la única señal que el endpoint da: no hay bandera, no hay
 * `body_chars`, y `left()` no deja marca. Un cuerpo de exactamente 240 caracteres se marca como
 * recortado sin serlo, y eso es deliberado: el error caro es el otro —presentar como completo lo
 * que no lo está—, y el texto que se pinta dice «puede estar recortado», no «está recortado».
 */
export function previsualizacionRecortada(preview: string | null | undefined): boolean {
  return typeof preview === 'string' && preview.length >= CARACTERES_DE_PREVISUALIZACION;
}

/**
 * El cuerpo entero, sacado de lo que devuelve `GET /v3/console/messages/:messageId`.
 *
 * `messages.body` es `jsonb` y lo que hay dentro depende de quién publicó: los adaptadores usan
 * `text`, los encargos usan `prompt`, y hay filas con otra forma. Se prueban las dos claves
 * conocidas y, si no está ninguna, se devuelve el JSON tal cual en vez de un vacío: un cuerpo con
 * una forma que la consola no conoce sigue siendo el cuerpo, y esconderlo sería el mismo defecto
 * en versión nueva.
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

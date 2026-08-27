/**
 * **Lo que el servidor publica del cuerpo de un mensaje, y lo que NO.**
 *
 * `GET /v3/console/messages` no devuelve el mensaje: devuelve `left(body,240)`. Está escrito en
 * `packages/store/src/repository.ts`, en la consulta de `listMessages`, y la consola no lo decía
 * en ninguna parte. 
 * 100 items, largo máximo de `body_preview` = 240 caracteres exactos, mínimo 4. En pantalla se
 * leía «…Yo pare lo que habia arranca» y «…El dominio real es stevenvallejo», cortados a mitad de
 * palabra, sin puntos suspensivos, sin «ver más» —cero coincidencias de `ver mas|expandir|mostrar
 * todo` en el bundle desplegado— y con un panel de detalle que muestra room, lane, actor, tenant,
 * trace y message id pero NO el cuerpo.
 *
 * O sea: la consola presentaba un mensaje recortado con la misma cara con la que presenta uno
 * entero. Eso es mentir por omisión, que es exactamente lo que esta vista existe para no hacer.
 *
 * Este módulo es la parte pura del arreglo: el número que el servidor aplica y cómo se decide que
 * un texto viene cortado. Vive aparte para que una prueba pueda atarlo al SQL que lo produce
 * (`cuerpo-del-mensaje.test.ts`): si alguien cambia el `left(...,240)` de la consulta y no toca
 * esta constante, la consola vuelve a marcar el corte donde no está —o deja de marcarlo donde sí—
 * y ni el typecheck, ni el lint, ni ninguna prueba de DOM dicen una palabra.
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

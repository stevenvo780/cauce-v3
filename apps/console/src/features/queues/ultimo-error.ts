import type { DeliveryState } from '../../api/types';

/**
 * **«UNKNOWN» ÁMBAR EN LA COLUMNA DE ERRORES DE ENTREGAS QUE SALIERON BIEN.**
 *
 *  38 filas en la tabla de `/queues`, de las
 * cuales 31 gritaban un `UNKNOWN` en ámbar bajo «Último error». Las 31 estaban en `done`. El ojo
 * del operador iba a ese color —treinta y una veces— y las 7 dead letters, que son lo único que
 * hay que mirar, quedaban sueltas entre ellas sin nada que las distinguiera.
 *
 * El defecto es de vocabulario, no de dato. `<Unknown>` pinta ámbar cuando el valor es nulo, y esa
 * regla es correcta casi siempre: significa «el servidor no lo dijo, y esta consola no rellena con
 * ceros lo que no sabe». Pero para `last_error` de una entrega TERMINADA BIEN, el nulo no es
 * ignorancia: es la respuesta. Que no haya error es exactamente lo que una entrega en `done`
 * tiene que informar, y pintarlo del color de la alarma convierte el acierto en ruido.
 *
 * La distinción, entonces, es por ESTADO:
 * - estado sin error (`done`, `pending`, `leased`, `accepted`, `started`) + `last_error` nulo
 *   → «sin error», apagado. Es un hecho, no un hueco.
 * - estado de error (`dead`, `failed`, `retry`) + `last_error` nulo
 *   → UNKNOWN, ámbar. Acá sí falta un dato, y falta uno grave: una entrega muerta sin motivo es
 *     una entrega que nadie puede diagnosticar. Ese ámbar hay que conservarlo.
 * - estado UNKNOWN → UNKNOWN. No se puede afirmar «sin error» sobre una fila cuyo estado no se
 *   conoce; eso sería inventar la mitad tranquilizadora.
 */

/** Estados en los que «sin error» es una AFIRMACIÓN del servidor y no un hueco. */
const ESTADOS_SIN_ERROR: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  'done', 'pending', 'leased', 'accepted', 'started',
]);

export type LecturaDeUltimoError =
  /** El servidor dijo qué falló. */
  | { clase: 'texto'; texto: string }
  /** El servidor dijo que no falló nada: el estado lo garantiza. */
  | { clase: 'sin-error' }
  /** Falta el dato, y en este estado su falta importa. */
  | { clase: 'desconocido' };

export function leerUltimoError(
  estado: DeliveryState | undefined,
  ultimoError: string | null | undefined,
): LecturaDeUltimoError {
  if (typeof ultimoError === 'string' && ultimoError.trim()) return { clase: 'texto', texto: ultimoError };
  if (estado !== undefined && ESTADOS_SIN_ERROR.has(estado)) return { clase: 'sin-error' };
  return { clase: 'desconocido' };
}

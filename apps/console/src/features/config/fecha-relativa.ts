import { UNKNOWN, timestamp } from '../../lib';

/**
 * La columna «Alta» de cada tabla de `/config` repetía `1 jul 2026, 10:00:00` en cada fila, partido
 * en tres líneas por lo angosto de la celda. Veinte veces la misma fecha exacta no es información:
 * es ruido que estira la fila y esconde lo único que el operador quiere saber de un vistazo, que es
 * si la fila es de ayer o del año pasado.
 *
 * Acá se pinta **la distancia** —«hace 53 d»— y la fecha exacta se conserva ENTERA en el `title`.
 * No se pierde ningún dato: cambia cuál de los dos está a la vista.
 *
 * Por qué no `Intl.RelativeTimeFormat` en `narrow` para todo: en castellano el narrow de *mes* y el
 * de *minuto* son los dos «m» («hace 2 m»), así que de dos meses para arriba se usa el formato largo
 * («hace 2 meses»), que no se puede confundir con nada.
 */

const NARROW = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'narrow' });
const LARGO = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

export interface FechaRelativa {
  /** Lo que se lee en la celda. */
  texto: string;
  /** La fecha exacta, para el `title` y para el lector de pantalla. */
  absoluta: string;
  /** El ISO original, para el `dateTime` del `<time>`. */
  iso: string;
}

/**
 * `undefined` cuando el valor no es una fecha que se pueda leer. Quien llama decide qué pintar en
 * ese caso —hoy, un `UNKNOWN` explícito—: inventar acá un «hace un rato» sería afirmar una
 * antigüedad que nadie midió.
 */
export function fechaRelativa(valor: unknown, ahora: number = Date.now()): FechaRelativa | undefined {
  if (typeof valor !== 'string' || valor.trim() === '') return undefined;
  const momento = Date.parse(valor);
  if (Number.isNaN(momento)) return undefined;
  const absoluta = timestamp(valor);
  if (absoluta === UNKNOWN) return undefined;
  return { texto: distancia(momento - ahora), absoluta, iso: valor };
}

/** `delta` en milisegundos: negativo es pasado, positivo es futuro. */
function distancia(delta: number): string {
  const magnitud = Math.abs(delta);
  const signo = Math.sign(delta) || 1;
  if (magnitud < 45_000) return NARROW.format(Math.round(delta / 1000), 'second');
  if (magnitud < HORA) return NARROW.format(signo * Math.round(magnitud / MINUTO), 'minute');
  if (magnitud < DIA) return NARROW.format(signo * Math.round(magnitud / HORA), 'hour');
  // Hasta 60 días se cuenta en días: «hace 53 d» es más útil que «hace 2 meses» para saber si algo
  // se dio de alta esta semana o la anterior.
  if (magnitud < 60 * DIA) return NARROW.format(signo * Math.round(magnitud / DIA), 'day');
  if (magnitud < 365 * DIA) return LARGO.format(signo * Math.round(magnitud / (30 * DIA)), 'month');
  return LARGO.format(signo * Math.round(magnitud / (365 * DIA)), 'year');
}

import { UNKNOWN, timestamp } from '../../lib';

/**
 * The "Alta" column of every `/config` table repeated `1 jul 2026, 10:00:00` on every row, split
 * into three lines by the cell's narrow width. Twenty identical exact timestamps are not
 * information: they are noise that stretches the row and hides the single thing the operator
 * wants to see at a glance, which is whether the row is from yesterday or last year.
 *
 * Here we paint **the distance** — "53 d ago" — and the exact date is preserved WHOLE in the
 * `title`. No data is lost: which of the two is at the front changes.
 *
 * Why not `Intl.RelativeTimeFormat` in `narrow` for everything: in Spanish the narrow form of
 * *month* and *minute* are both "m" ("hace 2 m"), so above two months the long form is used
 * ("hace 2 meses"), which cannot be confused with anything.
 */

const NARROW = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'narrow' });
const LARGO = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

export interface FechaRelativa {
  /** What is read in the cell. */
  texto: string;
  /** The exact date, for the `title` and for the screen reader. */
  absoluta: string;
  /** The original ISO, for the `<time>` element's `dateTime`. */
  iso: string;
}

/**
 * `undefined` when the value is not a date that can be read. The caller decides what to paint
 * in that case — today, an explicit `UNKNOWN` —: inventing an "a while ago" here would be asserting
 * an age that nobody measured.
 */
export function fechaRelativa(valor: unknown, ahora: number = Date.now()): FechaRelativa | undefined {
  if (typeof valor !== 'string' || valor.trim() === '') return undefined;
  const momento = Date.parse(valor);
  if (Number.isNaN(momento)) return undefined;
  const absoluta = timestamp(valor);
  if (absoluta === UNKNOWN) return undefined;
  return { texto: distancia(momento - ahora), absoluta, iso: valor };
}

/** `delta` in milliseconds: negative is past, positive is future. */
function distancia(delta: number): string {
  const magnitud = Math.abs(delta);
  const signo = Math.sign(delta) || 1;
  if (magnitud < 45_000) return NARROW.format(Math.round(delta / 1000), 'second');
  if (magnitud < HORA) return NARROW.format(signo * Math.round(magnitud / MINUTO), 'minute');
  if (magnitud < DIA) return NARROW.format(signo * Math.round(magnitud / HORA), 'hour');
  // Up to 60 days is counted in days: "53 d ago" is more useful than "2 months ago" to know if
  // something was registered this week or last week.
  if (magnitud < 60 * DIA) return NARROW.format(signo * Math.round(magnitud / DIA), 'day');
  if (magnitud < 365 * DIA) return LARGO.format(signo * Math.round(magnitud / (30 * DIA)), 'month');
  return LARGO.format(signo * Math.round(magnitud / (365 * DIA)), 'year');
}

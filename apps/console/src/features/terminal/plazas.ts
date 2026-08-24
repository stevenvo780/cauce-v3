/**
 * Qué sesiones de terminal siguen OCUPANDO una plaza del operador.
 *
 * 🔴 Esto existe por un fallo medido contra producción el 2026-08-23, y es la razón por la que
 * Ultimate Terminal «nunca ha funcionado»:
 *
 *   1. abrí la TUI de dos alias        → 2 tarjetas, 2 nodos `.pty-host`, 2 sesiones `active`;
 *   2. navegá a Portada y volvé        → 0 tarjetas, 2 nodos `.pty-host` VIVOS, 2 sesiones `active`;
 *   3. abrí un tercer alias            → HTTP 409 `session_limit`.
 *
 * El tope del gateway es por OPERADOR (`maxSessionsPerOperator`, 2 por defecto) y una sesión
 * consumida sigue contando 900 s aunque su pestaña ya no exista. La consola perdía el `grant` al
 * desmontar el workspace, así que la propia pantalla que decía «cerrá alguna de las sesiones que
 * tenés abiertas» no tenía NINGUNA sesión que cerrar. Quince minutos muerto, sin un solo error
 * que lo explicara.
 *
 * El arreglo son dos cosas y hacen falta las dos: soltar las sesiones al desmontar la vista
 * (`OperatorWorkspace`), y —para lo que se cuele igual: otra pestaña, un cierre a lo bruto, un
 * navegador que se fue— PODER VERLAS Y CERRARLAS. Este módulo es el criterio de «cuáles cuentan».
 */
import type { TerminalSessionListItem } from './api';

/**
 * Espejo EXACTO del `openPredicate` del gateway (`services/gateway/src/terminal/plugin.ts`):
 *
 *   closed_at IS NULL AND revoked_at IS NULL
 *   AND ((consumed_at IS NULL AND expires_at > now())
 *        OR (consumed_at IS NOT NULL AND consumed_at + ttl > now()))
 *
 * El listado ya trae resuelta la primera mitad en `state` (`closed` = cerrada o revocada) y la
 * segunda en `expires_at` (para una sesión consumida el servidor manda `consumed_at + ttl`, no el
 * vencimiento del ticket). O sea que acá alcanza con las dos comprobaciones de abajo — pero las
 * DOS: sin la del reloj, un ticket que caducó a las 17:50 se sigue listando como `issued` y la
 * consola le pediría al operador que cierre una sesión que no ocupa nada.
 */
export function ocupaPlaza(item: TerminalSessionListItem, ahora: number = Date.now()): boolean {
  if (item.state === 'closed') return false;
  const vence = Date.parse(item.expires_at);
  if (!Number.isFinite(vence)) return false;
  return vence > ahora;
}

/** Las sesiones que hoy le están gastando plazas a este operador, de la más reciente a la más vieja. */
export function plazasOcupadas(
  items: readonly TerminalSessionListItem[],
  ahora: number = Date.now(),
): TerminalSessionListItem[] {
  return items
    .filter((item) => ocupaPlaza(item, ahora))
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
}

/**
 * Las que ocupan plaza y NO tiene a la vista esta pestaña: son las colgadas, las que hay que poder
 * cerrar a mano. `conocidas` son los `session_id` de los grants que este workspace sí gobierna.
 */
export function plazasColgadas(
  items: readonly TerminalSessionListItem[],
  conocidas: readonly string[],
  ahora: number = Date.now(),
): TerminalSessionListItem[] {
  const propias = new Set(conocidas);
  return plazasOcupadas(items, ahora).filter((item) => !propias.has(item.session_id));
}

/** Minutos que le quedan a una sesión antes de soltar la plaza sola. Para no mentir con «se libera ya». */
export function minutosParaLiberar(item: TerminalSessionListItem, ahora: number = Date.now()): number {
  const vence = Date.parse(item.expires_at);
  if (!Number.isFinite(vence)) return 0;
  return Math.max(0, Math.ceil((vence - ahora) / 60_000));
}

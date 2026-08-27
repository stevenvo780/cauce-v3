/**
 * Criterio de conciliación de plazas ocupadas por sesiones PTY del operador.
 * Permite identificar sesiones activas y liberar sesiones huérfanas frente al tope maxSessionsPerOperator.
 */
import type { TerminalSessionListItem } from './api';

/**
 * Proyección del `openPredicate` del gateway (`services/gateway/src/terminal/plugin.ts`):
 *
 *   closed_at IS NULL AND revoked_at IS NULL
 *   AND ((consumed_at IS NULL AND expires_at > now())
 *        OR (consumed_at IS NOT NULL AND consumed_at + ttl > now()))
 *
 * PostgreSQL evalúa la expresión ENTERA con su reloj y el gateway proyecta `state: closed` cuando
 * ya no ocupa. El navegador no vuelve a comparar `expires_at` con `Date.now()`: un portátil con
 * el reloj adelantado ocultaría precisamente la sesión que bloquea al operador. La fecha queda
 * sólo para explicar aproximadamente cuánto falta.
 */
export function ocupaPlaza(item: TerminalSessionListItem): boolean {
  return item.state !== 'closed';
}

/** Las sesiones que hoy le están gastando plazas a este operador, de la más reciente a la más vieja. */
export function plazasOcupadas(
  items: readonly TerminalSessionListItem[],
): TerminalSessionListItem[] {
  return items
    .filter((item) => ocupaPlaza(item))
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
}

/**
 * Las que ocupan plaza y NO tiene a la vista esta pestaña: son las colgadas, las que hay que poder
 * cerrar a mano. `conocidas` son los `session_id` de los grants que este workspace sí gobierna.
 */
export function plazasColgadas(
  items: readonly TerminalSessionListItem[],
  conocidas: readonly string[],
): TerminalSessionListItem[] {
  const propias = new Set(conocidas);
  return plazasOcupadas(items).filter((item) => !propias.has(item.session_id));
}

/** Minutos que le quedan a una sesión antes de soltar la plaza sola. Para no mentir con «se libera ya». */
export function minutosParaLiberar(item: TerminalSessionListItem, ahora: number = Date.now()): number {
  const vence = Date.parse(item.expires_at);
  if (!Number.isFinite(vence)) return 0;
  return Math.max(0, Math.ceil((vence - ahora) / 60_000));
}

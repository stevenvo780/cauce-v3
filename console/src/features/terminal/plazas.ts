/**
 * Slot reconciliation criterion for PTY operator sessions.
 * Identifies active sessions and frees orphan ones against the maxSessionsPerOperator cap.
 */
import type { TerminalSessionListItem } from './api';

/**
 * Projection of the gateway's `openPredicate` (`services/gateway/src/terminal/plugin.ts`):
 *
 *   closed_at IS NULL AND revoked_at IS NULL
 *   AND ((consumed_at IS NULL AND expires_at > now())
 *        OR (consumed_at IS NOT NULL AND consumed_at + ttl > now()))
 *
 * PostgreSQL evaluates the WHOLE expression with its own clock, and the gateway projects
 * `state: closed` when it no longer occupies. The browser does not re-compare `expires_at`
 * against `Date.now()`: a laptop with an advanced clock would hide precisely the session that
 * is blocking the operator. The date is only kept to roughly explain how much is left.
 */
export function ocupaPlaza(item: TerminalSessionListItem): boolean {
  return item.state !== 'closed';
}

/** Sessions currently consuming slots for this operator, from most recent to oldest. */
export function plazasOcupadas(
  items: readonly TerminalSessionListItem[],
): TerminalSessionListItem[] {
  return items
    .filter((item) => ocupaPlaza(item))
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
}

/**
 * Those that occupy a slot and are NOT visible to this tab: the hung ones, the ones that must
 * be closeable by hand. `conocidas` are the `session_id`s of the grants this workspace does govern.
 */
export function plazasColgadas(
  items: readonly TerminalSessionListItem[],
  conocidas: readonly string[],
): TerminalSessionListItem[] {
  const propias = new Set(conocidas);
  return plazasOcupadas(items).filter((item) => !propias.has(item.session_id));
}

/** Minutes left before a session releases its slot on its own. So as not to lie with "released now". */
export function minutosParaLiberar(item: TerminalSessionListItem, ahora: number = Date.now()): number {
  const vence = Date.parse(item.expires_at);
  if (!Number.isFinite(vence)) return 0;
  return Math.max(0, Math.ceil((vence - ahora) / 60_000));
}

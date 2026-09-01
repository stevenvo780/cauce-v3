import type { DeliveryState } from '../../api/types';
import { deliveryPolicy } from '../deliveries/delivery-policy';

/**
 * **AMBER "UNKNOWN" IN THE ERROR COLUMN OF DELIVERIES THAT SUCCEEDED.**
 *
 * 38 rows in the `/queues` table, of which 31 were shouting an amber `UNKNOWN` under "Last error".
 * All 31 were in `done`. The operator's eye went to that color — thirty-one times — and the 7
 * dead letters, which are the only thing worth looking at, were lost among them with nothing to
 * set them apart.
 *
 * The defect is in the vocabulary, not in the data. `<Unknown>` paints amber when the value is
 * null, and that rule is right almost everywhere: it means "the server did not say, and this
 * console does not fill with zeros what it does not know". But for `last_error` of a delivery
 * that FINISHED WELL, null is not ignorance: it is the answer. The absence of an error is exactly
 * what a `done` delivery must report; painting it in the alarm color turns the success into noise.
 *
 * The distinction, then, is by STATE:
 * - non-error state (`done`, `pending`, `leased`, `accepted`, `started`) + null `last_error`
 *   → "no error", muted. It is a fact, not a gap.
 * - error state (`dead`, `failed`, `retry`) + null `last_error`
 *   → UNKNOWN, amber. Here the data really is missing, and gravely so: a dead delivery without
 *     a reason is one nobody can diagnose. That amber must be kept.
 * - UNKNOWN state → UNKNOWN. One cannot assert "no error" on a row whose state is unknown; that
 *   would be inventing the reassuring half.
 */

type LecturaDeUltimoError =
  /** The server said what failed. */
  | { clase: 'texto'; texto: string }
  /** The server said nothing failed: the state guarantees it. */
  | { clase: 'sin-error' }
  /** The data is missing, and in this state its absence matters. */
  | { clase: 'desconocido' };

export function leerUltimoError(
  estado: DeliveryState | undefined,
  ultimoError: string | null | undefined,
): LecturaDeUltimoError {
  if (typeof ultimoError === 'string' && ultimoError.trim()) return { clase: 'texto', texto: ultimoError };
  if (deliveryPolicy(estado).errorExpectation === 'absent') return { clase: 'sin-error' };
  return { clase: 'desconocido' };
}

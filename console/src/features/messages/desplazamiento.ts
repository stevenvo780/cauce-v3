/**
 * Utilities for automatic scroll control and anchoring to the end of the message thread.
 */

/**
 * How far from the end still counts as "watching the end".
 *
 * Not zero: a thread with images or fonts that finish loading shifts the background a few pixels,
 * and with zero margin the operator would end up "detached" without having touched anything — new
 * messages then stop following. 80 px is less than one bubble, so it never covers a message.
 */
export const MARGEN_PEGADO = 80;

interface CajaDesplazable {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Is the operator watching the end of the thread? Whether new messages follow them depends on this. */
export function estaPegadoAlFinal(caja: CajaDesplazable): boolean {
  return caja.scrollHeight - caja.scrollTop - caja.clientHeight <= MARGEN_PEGADO;
}

/**
 * Moves the box to the end.
 *
 * Uses `scrollTo` when available and falls back to `scrollTop` when not: `Element.prototype.scrollTo`
 * is not implemented in jsdom, and a test that only spies on `scrollTop` would not distinguish
 * "not called" from "called and jsdom ignored it" — jsdom has no layout, so `scrollHeight` is 0
 * and the assignment stays at 0 no matter what. With `scrollTo` in between the test can assert
 * the EFFECT: which box and to which destination.
 */
export function irAlFinal(caja: HTMLElement, suave = false): void {
  const destino = caja.scrollHeight;
  if (typeof caja.scrollTo === 'function') {
    caja.scrollTo({ top: destino, behavior: suave ? 'smooth' : 'auto' });
    return;
  }
  caja.scrollTop = destino;
}

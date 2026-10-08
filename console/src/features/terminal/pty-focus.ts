import { holder } from './pty-theme';
import type { PtyEntry } from './pty-types';

/** Elements that hand focus to the terminal once it becomes writable (the take button). */
export const YIELDS_FOCUS_ATTRIBUTE = 'data-yields-focus';

function focusIsFree(entry: PtyEntry): boolean {
  const active = document.activeElement;
  return !active || active === document.body || entry.container.contains(active) || active.closest(`[${YIELDS_FOCUS_ATTRIBUTE}]`) !== null;
}

export function focusWritablePty(entry: PtyEntry): void {
  if (entry.readOnly || entry.view.state !== 'open') return;
  // The detached holder is only visibility:hidden, so it still has boxes: it is excluded by identity.
  const mount = entry.container.parentElement;
  if (!entry.container.isConnected || !mount || holder().contains(mount) || mount.getClientRects().length === 0) return;
  // An operator who already moved to a form field must not lose it to a take that lands later.
  if (!focusIsFree(entry)) return;
  try {
    entry.terminal.focus();
  } catch {
    // A headless renderer may have no focus target.
  }
}

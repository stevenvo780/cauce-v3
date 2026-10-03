import type { PtyEntry } from './pty-types';

/** Called after an explicit take/reattach, never an authority to enable input. */
export function focusWritablePty(entry: PtyEntry): void {
  if (entry.readOnly || entry.view.state !== 'open') return;
  const mount = entry.container.closest('.pty-mount');
  if (!mount?.isConnected || mount.getClientRects().length === 0) return;
  try {
    entry.terminal.focus();
  } catch {
    // A headless renderer may have no focus target.
  }
}

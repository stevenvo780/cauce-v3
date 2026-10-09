import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { TriangleAlert, X } from 'lucide-react';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './kit';

/**
 * The confirmation of an action that cannot be undone silently. Escape and the inert background
 * come from the dialog primitive; `busy` keeps it open while the request is in flight.
 */
export function ConfirmDialog({
  open, title, confirmLabel, cancelLabel = 'No hacer nada', busy = false, confirmDisabled = false,
  tone = 'warn', onConfirm, onCancel, children,
}: {
  open: boolean;
  title: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  tone?: 'warn' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <AlertDialog.Popup initialFocus={confirmDisabled ? undefined : confirm}
          className="fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop">
          <AlertDialog.Title className="m-0 flex items-start gap-2 text-[15px] font-semibold">
            <TriangleAlert size={16} aria-hidden="true" className={cn('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warn')} />
            <span>{title}</span>
          </AlertDialog.Title>
          {children ? <div className="grid gap-3 text-[13px] leading-relaxed text-fg-2 [&_p]:m-0">{children}</div> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
            <Button variant="primary" ref={confirm} disabled={busy || confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** A modal form: the title, an optional purpose line, and room for the fields and the write bar. */
export function FormDialog({ open, title, description, busy = false, wide = false, anchorTop = false, initialFocus, finalFocus, onClose, children }: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  busy?: boolean;
  wide?: boolean;
  /** Pinned to the top edge: content that grows below (a receipt) must not move the buttons the operator is about to press. */
  anchorTop?: boolean;
  initialFocus?: ComponentProps<typeof Dialog.Popup>['initialFocus'];
  finalFocus?: ComponentProps<typeof Dialog.Popup>['finalFocus'];
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next, details) => {
      if (next) return;
      // Focus drifting out, or a press on a node a re-render already replaced (the opening click itself), is not a request to close.
      const pressed = details.event.target;
      if (details.reason === 'focus-out' || (details.reason === 'outside-press' && pressed instanceof Node && !pressed.isConnected)) {
        details.cancel(); return;
      }
      if (!busy) onClose();
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup initialFocus={initialFocus} finalFocus={finalFocus}
          className={cn('fixed left-1/2 z-50 grid max-h-[calc(100dvh-1.5rem)] -translate-x-1/2 content-start gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop',
            anchorTop ? 'top-3 sm:top-[6dvh] max-h-[calc(100dvh-1.5rem)] sm:max-h-[88dvh]' : 'top-1/2 -translate-y-1/2',
            wide ? 'w-[min(94vw,720px)]' : 'w-[min(94vw,640px)]')}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-base font-semibold">{title}</Dialog.Title>
              {description ? <Dialog.Description className="m-0 mt-0.5 text-xs text-muted">{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close aria-label="Cerrar" disabled={busy}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

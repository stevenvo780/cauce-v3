import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

const PHONE_FULL = 'max-[760px]:top-0 max-[760px]:left-0 max-[760px]:h-dvh max-[760px]:max-h-none max-[760px]:w-screen '
  + 'max-[760px]:max-w-none max-[760px]:translate-x-0 max-[760px]:translate-y-0 max-[760px]:rounded-none max-[760px]:border-0';

/** A centered modal on desktop, a full-screen sheet on phones. Header and footer stay put; the body scrolls. */
export const WIZARD_POPUP = 'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 '
  + `flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop outline-none ${PHONE_FULL}`;

/** A right-side drawer on desktop, a full-screen sheet on phones. */
export const DRAWER_POPUP = 'fixed top-0 right-0 z-50 flex h-dvh w-[min(100vw,600px)] flex-col overflow-hidden border-l border-line bg-surface '
  + 'shadow-pop outline-none transition-transform duration-200 motion-reduce:transition-none '
  + 'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full max-[760px]:w-screen max-[760px]:border-l-0';

export const DIALOG_BODY = 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4';
export const DIALOG_FOOTER = 'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3';

export function CloseButton({ disabled = false }: { disabled?: boolean }) {
  return <Dialog.Close aria-label="Cerrar" disabled={disabled}
    className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50">
    <X size={16} aria-hidden="true" />
  </Dialog.Close>;
}

export function WizardHeader({ title, description, busy }: { title: ReactNode; description?: ReactNode; busy: boolean }) {
  return <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
    <div className="min-w-0">
      <Dialog.Title className="m-0 text-base font-semibold">{title}</Dialog.Title>
      {description ? <Dialog.Description className="m-0 mt-0.5 text-xs text-muted">{description}</Dialog.Description> : null}
    </div>
    <CloseButton disabled={busy} />
  </div>;
}

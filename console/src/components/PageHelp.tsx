import { Dialog } from '@base-ui/react/dialog';
import { HelpCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';

/** The page explanation lives behind this button, so the header carries a title and not prose. */
export function PageHelp({ title, description, children }: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        className="page-help-boton grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted transition-colors hover:bg-subtle hover:text-fg"
        aria-label={`Qué es «${title}»`}
        title={`Qué es «${title}» y qué exige`}
      >
        <HelpCircle size={16} aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop">
          <div className="mb-2 flex items-start justify-between gap-4">
            <Dialog.Title className="m-0 text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label="Cerrar" className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="m-0 text-[13px] leading-relaxed text-fg-2">{description}</Dialog.Description>
          {children ? <div className="page-help-extra mt-3 grid gap-2 border-t border-line pt-3 text-[13px] text-muted">{children}</div> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

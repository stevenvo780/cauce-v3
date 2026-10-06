import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import { ChevronRight, Search, TriangleAlert, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '../cn';
import { display } from '../lib';
import { Button } from './form-kit';

export type KpiTone = 'neutral' | 'positive' | 'warning' | 'danger';

const KPI_INK: Record<KpiTone, string> = {
  neutral: 'text-fg',
  positive: 'text-ok-ink',
  warning: 'text-warn-ink',
  danger: 'text-danger-ink',
};

/** A compact row of figures: two columns on a phone, one per figure from `sm` up. */
export function KpiGrid({ cols = 4, label, className, children }: {
  cols?: 3 | 4 | 5;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const wide = cols === 3 ? 'sm:grid-cols-3' : cols === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-5';
  return (
    <div role={label ? 'group' : undefined} aria-label={label} className={cn('mb-4 grid grid-cols-2 gap-2', wide, className)}>
      {children}
    </div>
  );
}

/** One figure. With `onPress` it is a toggle button (`pressed` marks the active one). */
export function Kpi({ label, value, detail, tone = 'neutral', onPress, pressed, disabled, title }: {
  label: string;
  value: unknown;
  detail?: ReactNode;
  tone?: KpiTone;
  onPress?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const body = <>
    <span className="text-xs text-muted">{label}</span>
    <strong className={cn('text-xl leading-tight font-semibold tabular-nums', KPI_INK[tone])}>{display(value)}</strong>
    {detail ? <span className="text-xs leading-snug text-muted">{detail}</span> : null}
  </>;
  const box = 'flex min-w-0 flex-col items-start gap-0.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-left';
  if (!onPress) return <article data-tone={tone} className={box}>{body}</article>;
  return (
    <button type="button" data-tone={tone} aria-pressed={pressed} disabled={disabled} title={title} onClick={onPress}
      className={cn(box, 'cursor-pointer font-[inherit] transition-colors enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60',
        pressed && 'border-brand bg-brand-soft')}>
      {body}
    </button>
  );
}

/** A search box with an icon; the label is for screen readers. */
export function SearchField({ label, value, onChange, placeholder, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn('relative block min-w-0 flex-1 basis-64', className)}>
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <span className="sr-only">{label}</span>
      <input type="search" value={value} placeholder={placeholder} className="w-full pl-9"
        onChange={(event) => { onChange(event.target.value); }} />
    </label>
  );
}

/** A thin line for the filters and counters above a table. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-3 flex flex-wrap items-center gap-x-3 gap-y-2', className)}>{children}</div>;
}

/**
 * Below `md` each table row becomes a two-column card: the header turns screen-reader-only and
 * every cell carries its column name (`data-label`) as a small caption above its value. The first
 * cell and any `data-wide` cell take the full width. Pair it with `SCROLL` on the wrapper.
 */
export const CARD_TABLE = 'max-md:block max-md:[&_tbody]:block max-md:[&_thead]:sr-only max-md:[&_tr]:grid max-md:[&_tr]:grid-cols-2 '
  + 'max-md:[&_tr]:gap-x-3 max-md:[&_tr]:gap-y-1.5 max-md:[&_tr]:rounded-lg max-md:[&_tr]:border max-md:[&_tr]:border-line '
  + 'max-md:[&_tr]:bg-surface max-md:[&_tr]:p-3 max-md:[&_tbody_tr+tr]:mt-2 max-md:[&_td]:block max-md:[&_td]:min-w-0 '
  + 'max-md:[&_td]:border-0 max-md:[&_td]:p-0 '
  + 'max-md:[&_td]:[overflow-wrap:anywhere] max-md:[&_td]:before:mb-0.5 max-md:[&_td]:before:block max-md:[&_td]:before:text-[11px] max-md:[&_td]:before:text-muted '
  + 'max-md:[&_td]:before:content-[attr(data-label)] max-md:[&_td:first-child]:col-span-2 max-md:[&_td:first-child]:before:hidden max-md:[&_td[data-wide]]:col-span-2 '
  + 'max-md:[&_tbody_tr:hover_td]:bg-transparent';

/** The scroll box of a table: a sticky header needs a bounded height, and a card list needs none of the frame. */
export const SCROLL = 'max-h-[min(70vh,720px)] overflow-auto rounded-lg border border-line bg-surface '
  + '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1] max-md:max-h-none max-md:overflow-visible max-md:border-0 max-md:bg-transparent';

/** A collapsible "what is this" block: the explanation is there when asked for and gone otherwise. */
export function Explain({ title = '¿Qué es esto?', children }: { title?: string; children: ReactNode }) {
  return (
    <Collapsible.Root className="mb-3 text-[13px]">
      <Collapsible.Trigger className="group flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-muted hover:text-fg">
        <ChevronRight size={13} aria-hidden="true" className="transition-transform group-data-[panel-open]:rotate-90" />
        {title}
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-2 grid gap-2 rounded-lg border border-line bg-subtle p-3 text-xs leading-relaxed text-fg-2 [&_p]:m-0">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

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
export function FormDialog({ open, title, description, busy = false, onClose, children }: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-1.5rem)] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 content-start gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop">
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

import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight, Search } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../cn';
import { display } from '../lib';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'border-transparent bg-brand text-on-brand enabled:hover:bg-brand-hover',
  secondary: 'border-line-strong bg-surface text-fg enabled:hover:bg-subtle',
  ghost: 'border-transparent bg-transparent text-fg-2 enabled:hover:bg-subtle enabled:hover:text-fg',
  danger: 'border-danger/40 bg-surface text-danger-ink enabled:hover:bg-danger-soft',
};
const SIZE: Record<Size, string> = { sm: 'min-h-7 px-2 text-xs', md: 'min-h-9 px-3 text-[13px]' };

function buttonClass(variant: Variant = 'secondary', size: Size = 'md', className?: string): string {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant], SIZE[size], className,
  );
}

export function Button({ variant, size, className, type = 'button', ...props }:
ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** A link that looks like a button. */
export function LinkButton({ variant, size, className, ...props }:
ComponentProps<'a'> & { variant?: Variant; size?: Size }) {
  return <a className={buttonClass(variant, size, className)} {...props} />;
}

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger';
const NOTICE: Record<NoticeTone, string> = {
  info: 'border-line bg-subtle text-fg-2',
  ok: 'border-ok/30 bg-ok-soft text-ok-ink',
  warn: 'border-warn/40 bg-warn-soft text-warn-ink',
  danger: 'border-danger/30 bg-danger-soft text-danger-ink',
};

/** A status message. The tone carries severity; the `role` is the caller's call (alert, status, note). */
export function Notice({ tone = 'info', className, children, ...props }:
ComponentProps<'div'> & { tone?: NoticeTone; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-[13px] leading-snug [&_p]:m-0 [&_p+p]:mt-1.5', NOTICE[tone], className)} {...props}>
      {children}
    </div>
  );
}

/** The outcome of a write. Success is announced politely; anything else interrupts. */
export function Outcome({ tone, canal, role, children }: {
  tone: 'success' | 'error' | 'parcial';
  /** Names the control whose write produced it, so two outcomes on a page are never mixed up. */
  canal?: string;
  /** Overrides the default: a switch outcome is always polite, even when partial. */
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <Notice tone={tone === 'error' ? 'danger' : tone === 'parcial' ? 'warn' : 'ok'}
      role={role ?? (tone === 'success' ? 'status' : 'alert')} data-canal={canal}>
      {children}
    </Notice>
  );
}

/** A titled block on the page: one purpose line under the heading, content below. */
export function SectionCard({ title, description, actions, level = 2, className, children }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level of the title: one below the heading that contains the card. */
  level?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const Heading = `h${String(level)}` as 'h2' | 'h3' | 'h4';
  return (
    <section aria-label={typeof title === 'string' ? title : undefined}
      className={cn('grid grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border border-line bg-surface p-4 shadow-card', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <Heading className="m-0 text-sm font-semibold tracking-tight text-fg">{title}</Heading>
          {description ? <p className="m-0 mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Spinner() {
  return <span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-brand" />;
}

/** The card a page shows instead of its content while loading, after a failure, or on a dead route. */
export function StateCard({ tone = 'neutral', className, children, ...props }:
ComponentProps<'div'> & { tone?: 'neutral' | 'danger' }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border p-4 text-[13px] [&_p]:m-0',
      tone === 'danger' ? 'border-danger/40 bg-danger-soft text-danger-ink' : 'border-line bg-surface', className)} {...props}>
      {children}
    </div>
  );
}

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
    <strong className={cn('text-2xl leading-tight font-semibold tabular-nums', KPI_INK[tone])}>{display(value)}</strong>
    {detail ? <span className="text-xs leading-snug text-muted">{detail}</span> : null}
  </>;
  const box = 'flex min-w-0 flex-col items-start gap-0.5 rounded-lg border border-line bg-surface px-3 py-3.5 text-left';
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

/** A dry-run or a pending mutation, shown as the server will read it. */
export const PREVIEW = 'm-0 max-h-96 overflow-auto rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg-2';

/** The popup and the rows of every Base UI menu in the console. */
export const MENU_POPUP = 'z-50 min-w-44 rounded-lg border border-line bg-surface p-1 text-[13px] text-fg shadow-pop outline-none';
export const MENU_ITEM = 'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-fg no-underline outline-none select-none data-[highlighted]:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../cn';

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

/** A titled block on the page: one purpose line under the heading, content below. */
export function SectionCard({ title, description, actions, className, children }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={typeof title === 'string' ? title : undefined}
      className={cn('grid grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border border-line bg-surface p-4 shadow-card', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <h3 className="m-0 text-sm font-semibold tracking-tight text-fg">{title}</h3>
          {description ? <p className="m-0 mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

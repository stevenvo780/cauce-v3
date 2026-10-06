import type { ReactNode } from 'react';
import { Notice } from '../../components/form-kit';

export const FORM_GRID = 'grid gap-3 md:grid-cols-2';
export const PREVIEW = 'm-0 max-h-96 overflow-auto rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg-2';
export const CHECK_LABEL = 'flex items-start gap-2 font-normal';
export const HINT = 'text-xs font-normal text-muted';

/**
 * Below `md` each row becomes a card: the header row turns screen-reader-only and every cell
 * carries its column name (`data-label`) as a visible caption.
 */
export const TABLA = 'w-full max-md:block max-md:[&_tbody]:block max-md:[&_thead]:sr-only max-md:[&_tr]:block max-md:[&_tr]:border-b '
  + 'max-md:[&_tr]:border-line max-md:[&_tr]:p-3 max-md:[&_td]:flex max-md:[&_td]:items-center max-md:[&_td]:justify-between '
  + 'max-md:[&_td]:gap-3 max-md:[&_td]:border-0 max-md:[&_td]:px-0 max-md:[&_td]:py-1 max-md:[&_td]:before:text-xs '
  + 'max-md:[&_td]:before:text-muted max-md:[&_td]:before:content-[attr(data-label)]';

/** The outcome of a write. Success is announced politely; anything else interrupts. */
export function Aviso({ tone, canal, role, children }: {
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

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { useId, type ReactNode } from 'react';

/**
 * Thin wrapper over Base UI Tooltip so callers keep one small API: a word in a paragraph, a
 * column header, or a node drawn in SVG (`FloatingTooltip`, anchored to a measured rectangle).
 * The bubble is portalled to `document.body`: inside an SVG it would be clipped by the scrolling
 * container and scaled by the viewBox.
 *
 * The native `title` is PRESERVED where it already existed: it is the screen-reader and
 * mouse-less user's fallback. This adds to it; it does not replace it.
 */

/** Delay before opening with the mouse. Without it, sweeping the screen triggers ten bubbles in a row. */
const TOOLTIP_DELAY_MS = 120;

export type TooltipPlacement = 'top' | 'bottom';

const POSITIONER = 'z-50';
const BUBBLE = 'max-w-72 rounded-lg border border-line bg-surface p-2.5 text-xs text-fg shadow-pop [&_strong]:block [&_strong]:text-[13px] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-muted';

export interface FloatingTooltipProps {
  /** Trigger's rectangle in viewport coordinates (`getBoundingClientRect()`). */
  anchor: DOMRect | null;
  open: boolean;
  children: ReactNode;
  /** Must match the trigger's `aria-describedby`. */
  id?: string;
  placement?: TooltipPlacement;
}

/**
 * The bubble, controlled from outside. The SVG cannot wrap a node in a `<span>`, so it emits its
 * rectangle via `onHover` and the page keeps ONE single bubble for all the nodes.
 */
export function FloatingTooltip({ anchor, open, children, id, placement = 'top' }: FloatingTooltipProps) {
  if (!open || !anchor) return null;
  return (
    <TooltipPrimitive.Root open>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          anchor={{ getBoundingClientRect: () => anchor }}
          side={placement}
          sideOffset={10}
          className={POSITIONER}
        >
          <TooltipPrimitive.Popup id={id} role="tooltip" className={BUBBLE}>{children}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export interface TooltipProps {
  /** What gets explained. Accepts nodes: multiple lines, `<strong>`, figures. */
  label: ReactNode;
  children: ReactNode;
  placement?: TooltipPlacement;
  /**
   * `false` when what is wrapped is ALREADY focusable (a `<button>`, a link). The wrapper stops
   * taking focus and relies on the child's `focus` event bubbling up here: two tab stops for a
   * single control is worse accessibility, not better.
   */
  focusable?: boolean;
  className?: string;
}

/** HTML wrapper. Opens with the mouse **and with keyboard focus**, closes with Esc. */
export function Tooltip({ label, children, placement = 'top', focusable = true, className }: TooltipProps) {
  const id = useId();
  const triggerClass = `underline decoration-line-strong decoration-dotted underline-offset-2 ${focusable ? 'cursor-help' : 'cursor-default'}${className ? ` ${className}` : ''}`;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        delay={TOOLTIP_DELAY_MS}
        render={(props, state) => (
          <span {...props} tabIndex={focusable ? 0 : undefined} className={triggerClass} aria-describedby={state.open ? id : undefined} />
        )}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={placement} sideOffset={10} className={POSITIONER}>
          <TooltipPrimitive.Popup id={id} role="tooltip" className={BUBBLE}>{label}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

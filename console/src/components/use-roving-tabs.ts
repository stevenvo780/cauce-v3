import { useRef, type KeyboardEvent, type RefCallback } from 'react';

/**
 * The keyboard of a tab strip: arrows move the selection and the focus travels with it, so the
 * caller pairs this with a single tab stop (`tabIndex={active ? 0 : -1}`). It lives outside
 * `ui.tsx` because that file's comment budget is closed.
 */
export function useRovingTabs(count: number, onMove: (index: number) => void): {
  tabRef: (index: number) => RefCallback<HTMLElement>;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, index: number) => void;
} {
  const tabs = useRef<(HTMLElement | null)[]>([]);
  return {
    tabRef: (index) => (element) => { tabs.current[index] = element; },
    onKeyDown: (event, index) => {
      if (count < 1) return;
      let next: number | undefined;
      if (event.key === 'ArrowRight') next = (index + 1) % count;
      if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = count - 1;
      if (next === undefined) return;
      event.preventDefault();
      onMove(next);
      tabs.current[next]?.focus();
    },
  };
}

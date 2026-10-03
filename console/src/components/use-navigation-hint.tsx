import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react';

interface Hold {
  control: HTMLElement;
  x: number;
  y: number;
  revealed: boolean;
}

function labelledControl(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('[data-navigation-label]') : null;
}

export function useNavigationHint(enabled: boolean, routeKey: string) {
  const [label, setLabel] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useRef<Hold | undefined>(undefined);
  const suppressedClick = useRef<{ control: HTMLElement; until: number } | undefined>(undefined);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    hold.current = undefined;
    suppressedClick.current = undefined;
    setLabel(undefined);
  }, []);

  useEffect(() => {
    dismiss();
    if (!enabled) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', dismiss);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', dismiss);
    };
  }, [enabled, routeKey, dismiss]);

  const bindings: HTMLAttributes<HTMLElement> = enabled ? {
    onFocusCapture(event) {
      const control = labelledControl(event.target);
      if (control && !hold.current) setLabel(control.dataset.navigationLabel);
    },
    onBlurCapture() { setLabel(undefined); },
    onPointerDownCapture(event) {
      const control = labelledControl(event.target);
      if (!control || event.pointerType !== 'touch' || !event.isPrimary) return;
      hold.current = { control, x: event.clientX, y: event.clientY, revealed: false };
      timer.current = setTimeout(() => {
        if (!hold.current) return;
        hold.current.revealed = true;
        setLabel(control.dataset.navigationLabel);
      }, 500);
    },
    onPointerMoveCapture(event) {
      if (hold.current && Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > 10) dismiss();
    },
    onPointerUpCapture() {
      clearTimeout(timer.current);
      if (hold.current?.revealed) {
        suppressedClick.current = { control: hold.current.control, until: Date.now() + 1000 };
        timer.current = setTimeout(dismiss, 1500);
      }
      hold.current = undefined;
    },
    onPointerCancelCapture: dismiss,
    onPointerLeave() { if (hold.current) dismiss(); },
    onContextMenuCapture(event) {
      const control = labelledControl(event.target);
      const suppressed = suppressedClick.current;
      if (control && (hold.current?.control === control
        || (suppressed?.control === control && Date.now() < suppressed.until))) event.preventDefault();
    },
    onClickCapture(event) {
      const suppressed = suppressedClick.current;
      if (event.detail > 0 && suppressed && Date.now() < suppressed.until
        && labelledControl(event.target) === suppressed.control) {
        event.preventDefault();
        event.stopPropagation();
        suppressedClick.current = undefined;
        return;
      }
      dismiss();
    },
  } : {};

  return { bindings, hint: enabled && label ? <span className="navigation-hint" role="tooltip">{label}</span> : null };
}

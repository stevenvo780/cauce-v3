import { useEffect, type RefObject } from 'react';

export function useConversationViewport(shellRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const height = viewport?.height ?? window.innerHeight;
      const bottom = height + (viewport?.offsetTop ?? 0);
      const typing = document.activeElement?.matches('.messenger-composer textarea') ?? false;
      const keyboardOpen = typing && window.innerHeight - height > 100;
      shell.style.setProperty('--messenger-viewport-height', `${String(bottom)}px`);
      if (keyboardOpen) {
        shell.dataset.keyboardOpen = 'true';
        shell.style.setProperty('--messenger-navigation-height', '0px');
      } else {
        delete shell.dataset.keyboardOpen;
        shell.style.removeProperty('--messenger-navigation-height');
      }
    };
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    return () => {
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
      shell.style.removeProperty('--messenger-viewport-height');
      shell.style.removeProperty('--messenger-navigation-height');
      delete shell.dataset.keyboardOpen;
    };
  }, [shellRef]);
}

import { recoverModuleLoad, reloadAfterModuleFailure } from './module-recovery';

/* Only labels reach console.error: a message body can carry server text. */
let active: (() => void) | undefined;

function labelOf(value: unknown): string {
  if (value instanceof Error) return value.name || 'Error';
  if (typeof value === 'object' && value !== null) {
    const named = (value as { name?: unknown }).name;
    if (typeof named === 'string' && named) return named;
  }
  return 'Unknown';
}

function report(name: string): void {
  console.error(`[consola] ${name} sin capturar en ${window.location.pathname}`);
}

export function installGlobalErrorReporting(): () => void {
  active?.();
  const onError = (event: ErrorEvent) => {
    if (recoverModuleLoad(event.error)) event.preventDefault();
    else report(labelOf(event.error));
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (recoverModuleLoad(event.reason)) event.preventDefault();
    else report(labelOf(event.reason));
  };
  const onPreloadError = (event: Event) => {
    if (reloadAfterModuleFailure()) event.preventDefault();
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('vite:preloadError', onPreloadError);
  const remove = (): void => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('vite:preloadError', onPreloadError);
    if (active === remove) active = undefined;
  };
  active = remove;
  return remove;
}

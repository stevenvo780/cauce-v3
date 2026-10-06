import { setupWorker } from 'msw/browser';
import { chatDemoHandlers } from './chat-demo';
import { handlers } from './handlers';
import { instalarPtyDeMentira, terminalDemoHandlers } from './terminal-demo';

/* Demo handlers go FIRST: MSW keeps the first match and `handlers.ts` answers `capability.available:false` for the view tests. */
export const worker = setupWorker(...terminalDemoHandlers, ...chatDemoHandlers, ...handlers);

/* Install the fake PTY AFTER `worker.start()`: MSW mounts its own `WebSocket` interceptor at startup and would overwrite ours. */
const arrancar = worker.start.bind(worker);
worker.start = async (...argumentos: Parameters<typeof worker.start>) => {
  const registro = await arrancar(...argumentos);
  instalarPtyDeMentira();
  return registro;
};

/** Keeps the MSW service worker alive and re-registered: an idle-killed worker loses its client set and lets every request through to the network. */
export function keepMockingAlive(intervalMs = 10_000): () => void {
  const reactivate = (): void => {
    navigator.serviceWorker.controller?.postMessage('MOCK_ACTIVATE');
  };
  const timer = window.setInterval(reactivate, intervalMs);
  document.addEventListener('visibilitychange', reactivate);
  window.addEventListener('focus', reactivate);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', reactivate);
    window.removeEventListener('focus', reactivate);
  };
}

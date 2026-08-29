import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { instalarPtyDeMentira, terminalDemoHandlers } from './terminal-demo';

/*
 * The terminal bench ones go FIRST: MSW keeps the first matching handler, and `handlers.ts`
 * answers `capability.available:false` —which the view tests assert—. Here, in the browser, the
 * opposite is needed in order to look at the PTY. See `terminal-demo.ts`.
 */
export const worker = setupWorker(...terminalDemoHandlers, ...handlers);

/*
 * The fake PTY is installed AFTER `worker.start()`, not before: MSW mounts its own `WebSocket`
 * interceptor at startup and overwrote ours without a word. It looked like "Connection: ERROR ·
 * Internal relay error (code 1011)" —i.e. the real socket trying to reach a gateway that does
 * not exist—, which is exactly what this bench exists to prevent.
 */
const arrancar = worker.start.bind(worker);
worker.start = async (...argumentos: Parameters<typeof worker.start>) => {
  const registro = await arrancar(...argumentos);
  instalarPtyDeMentira();
  return registro;
};

/**
 * Keeps the MSW service worker alive — and re-registered.
 *
 * The worker stores the clients with mocking enabled in a `Set` **in memory**
 * (`activeClientIds`, in `public/mockServiceWorker.js`). The browser shuts down an idle service
 * worker after ~30 s; when it later wakes it up, that `Set` comes back empty and its `fetch`
 * handler lets EVERYTHING through to the network (`if (activeClientIds.size === 0) return`). The
 * page remains "controlled" —`navigator.serviceWorker.controller` is still there— so there is no
 * error, no warning, nothing visibly broken: the data simply stops arriving.
 *
 * Measured on the deployed console: going directly into a view rendered it fully, but reaching
 * that same view via the menu half a minute later left the screen blank, with "UNKNOWN" instead
 * of data, because `GET /v3/console/topology` ended up being swallowed by the static server's SPA
 * fallback and returned `index.html`. Worse still: the session revalidation every 60 s fell into
 * the same real network and threw the "Could not verify the session" screen over a console that
 * had been working just moments before.
 *
 * The ping solves both halves of the problem with a single message: handling an event renews the
 * worker's life (so it is not shut down while the tab is open), and `MOCK_ACTIVATE` puts this
 * client back into the `Set` if it was shut down anyway — a machine suspension, for example. It
 * also fires on returning to the tab, which is when the worker is most likely to have died while
 * nobody was looking.
 */
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

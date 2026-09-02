import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installGlobalErrorReporting } from './error-reporting';
import './styles.css';

/**
 * Mocks are gated by ONE build flag: `VITE_USE_MOCKS`. Previously `import.meta.env.DEV` was also
 * required, which made publishing a demo impossible: a production build with the flag set would
 * start against a nonexistent backend and stay on error screens.
 *
 * The flag is a BUILD flag, not a runtime one: a build without it evaluates this condition as a
 * constant and the bundler drops the whole `import()`, so `msw` does not ship in the production
 * bundle. And when it is set, the app declares it on screen with the `MOCK API` badge in the top
 * bar (`App.tsx`): a demo that does not advertise itself as such is a lie.
 */
async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS !== 'true') return;
  try {
    const { worker, keepMockingAlive } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
    keepMockingAlive();
  } catch (cause) {
    // Mocks failing to start MUST NOT cost the whole application. Without this `catch`, the
    // promise rejects, the `.then()` below never runs, and React never mounts: blank screen,
    // with not a single word explaining why. Measured: behind basic auth, the service worker
    // registration may receive 401 (the browser does not yet have credentials cached for that
    // origin) and the whole console vanished because of that. Mounting anyway, the app shows and
    // each view reports its own network error, which is a diagnosis and not a void.
    console.error('[mocks] no se pudo iniciar MSW; la consola se monta igual y las vistas van a fallar contra el backend real.', cause);
  }
}

installGlobalErrorReporting();

void enableMocking().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

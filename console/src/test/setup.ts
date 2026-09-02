import '@testing-library/jest-dom/vitest';
import { transferableAbortController } from 'node:util';

const nativeAbortController = transferableAbortController();
Object.defineProperties(globalThis, {
  AbortController: {
    configurable: true,
    writable: true,
    value: nativeAbortController.constructor,
  },
  AbortSignal: {
    configurable: true,
    writable: true,
    value: nativeAbortController.signal.constructor,
  },
});
/*
 * `matchMedia` does NOT exist in jsdom, and xterm calls it when opening the renderer. Without this
 * shim, `terminal.open()` threw `this._parentWindow.matchMedia is not a function`, the session was
 * left with `renderError`, and —what matters— the VIEWPORT never came to exist: `scrollLines()`
 * moved nothing and `viewportY` was always equal to `baseY`. That is, any test about the terminal
 * scroll went green ALWAYS, whatever the code said. A test that cannot go red is not a test: this
 * shim is what gives it back the ability to fail.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/*
 * xterm creates a 1x1 canvas while its colour module is imported. jsdom's implementation logs a
 * hard "Not implemented" error even though xterm correctly falls back.  That made a green suite
 * noisy and hid real stderr.  The console uses xterm's DOM renderer (no canvas rendering is being
 * claimed here), so provide only the deterministic colour-litmus surface the import requires.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: (kind: string) => kind === '2d' ? {
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    } : null,
  });
}
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '../mocks/server';

configure({ asyncUtilTimeout: 5_000 }); // 1 s is the cliff under StrictMode + forked parallelism, not `testTimeout`.

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => { server.close(); });

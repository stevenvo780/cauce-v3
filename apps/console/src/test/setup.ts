import '@testing-library/jest-dom/vitest';
/*
 * 🔴 `matchMedia` NO existe en jsdom, y xterm lo llama al abrir el renderer. Sin este relleno,
 * `terminal.open()` lanzaba `this._parentWindow.matchMedia is not a function`, la sesión quedaba
 * con `renderError`, y —lo que importa— el VIEWPORT no llegaba a existir: `scrollLines()` no movía
 * nada y `viewportY` era siempre igual a `baseY`. O sea que cualquier prueba sobre el scroll del
 * terminal daba verde SIEMPRE, dijera lo que dijera el código. Una prueba que no puede dar rojo no
 * es una prueba: este relleno es lo que le devuelve la capacidad de fallar.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '../mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

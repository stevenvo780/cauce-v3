import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installGlobalErrorReporting } from './error-reporting';

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dispose = installGlobalErrorReporting();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

/** jsdom has no `PromiseRejectionEvent`, so the shape the listener reads is built by hand. */
function rejectWith(reason: unknown): void {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
}

/** The last listener cancels the event so jsdom does not re-report it as an uncaught exception. */
function throwWith(error: unknown): void {
  const swallow = (event: Event) => { event.preventDefault(); };
  window.addEventListener('error', swallow);
  window.dispatchEvent(new ErrorEvent('error', { error, cancelable: true }));
  window.removeEventListener('error', swallow);
}

function reportado(): string {
  return JSON.stringify(vi.mocked(console.error).mock.calls);
}

it('avisa de un error no capturado con su nombre y la ruta, nunca el cuerpo del mensaje', () => {
  window.history.pushState({}, '', '/terminal/Steven/zeus');
  throwWith(new TypeError('texto del servidor que no debe salir'));

  expect(console.error).toHaveBeenCalledTimes(1);
  expect(reportado()).toContain('TypeError');
  expect(reportado()).toContain('/terminal/Steven/zeus');
  expect(reportado()).not.toContain('texto del servidor');
});

it('avisa de una promesa rechazada igual que de un error, sin su cuerpo', () => {
  window.history.pushState({}, '', '/queues');
  rejectWith(new RangeError('detalle interno del gateway'));

  expect(console.error).toHaveBeenCalledTimes(1);
  expect(reportado()).toContain('RangeError');
  expect(reportado()).toContain('/queues');
  expect(reportado()).not.toContain('detalle interno');
});

it('instalar dos veces no duplica el aviso: la segunda instalación reemplaza a la primera', () => {
  dispose = installGlobalErrorReporting();

  throwWith(new TypeError('irrelevante'));

  expect(console.error).toHaveBeenCalledTimes(1);
});

it('el desinstalador retira LAS DOS escuchas: después de llamarlo no se avisa de nada', () => {
  dispose?.();
  dispose = undefined;

  throwWith(new TypeError('ya no se escucha'));
  rejectWith(new RangeError('ya no se escucha'));

  expect(console.error).not.toHaveBeenCalled();
});

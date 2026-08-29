import { describe, expect, it } from 'vitest';
import { statusOf } from './auth-session';
import type { ConsoleAuthState } from '../../api/types';

const autenticado: ConsoleAuthState = { authenticated: true };
const noAutenticado: ConsoleAuthState = { authenticated: false };
const nulo: ConsoleAuthState = { authenticated: null };
const error = new Error('gateway 500');

describe('statusOf', () => {
  it('el fail-closed solo rige la comprobación inicial: sin estado + error → error', () => {
    expect(statusOf(undefined, error)).toBe('error');
    expect(statusOf(undefined, undefined)).toBe('checking');
  });

  it('una sesión establecida NO se cae por un error transitorio de revalidación de fondo', () => {
    // Regresión: antes statusOf priorizaba `if (error) return "error"` y un 500/timeout/blip en el
    // poll de 60 s o al volver a la pestaña desmontaba toda la consola con la sesión ya viva.
    expect(statusOf(autenticado, error)).toBe('in');
  });

  it('un vencimiento real (authenticated:false, 200 sin error) sí lleva al login', () => {
    expect(statusOf(noAutenticado, undefined)).toBe('out');
    expect(statusOf(noAutenticado, error)).toBe('out');
  });

  it('sin BFF (authenticated:null) es unmanaged', () => {
    expect(statusOf(nulo, undefined)).toBe('unmanaged');
  });
});

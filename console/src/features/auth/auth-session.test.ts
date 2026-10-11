import { describe, expect, it } from 'vitest';
import { revalidatedState, sessionAuthority, statusOf } from './auth-session';
import { authSessionKey } from './account-identity';
import type { ConsoleAuthState, ConsoleAuthority } from '../../api/types';

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

describe('sessionAuthority', () => {
  const owner: ConsoleAuthority = { role: 'company_owner', scope: 'company', home_company: 'humanizar',
    acting_company: 'humanizar', platform_override: false };

  it('solo acepta la autoridad que el servidor decidió para una sesión viva y con un contrato conocido', () => {
    expect(sessionAuthority({ authenticated: true, authority: owner })).toEqual(owner);
    expect(sessionAuthority({ authenticated: false, authority: owner })).toBeUndefined();
    expect(sessionAuthority({ authenticated: true })).toBeUndefined();
    expect(sessionAuthority({ authenticated: true,
      authority: { ...owner, role: 'hub' } as unknown as ConsoleAuthority })).toBeUndefined();
  });

  it('un cambio de empresa o de rol de empresa vuelve a montar lo que cuelga de la sesión', () => {
    const base: ConsoleAuthState = { authenticated: true, subject: 'steven@example.test', csrf_token: 'csrf', authority: owner };
    const switched = { ...base, authority: { ...owner, role: 'platform_admin', scope: 'platform', acting_company: 'praxis',
      platform_override: true } } satisfies ConsoleAuthState;
    expect(authSessionKey(switched)).not.toBe(authSessionKey(base));
    expect(authSessionKey({ ...base, authority: { ...owner } })).toBe(authSessionKey(base));
    expect(authSessionKey({ ...base, home_tenant: 'Other' })).not.toBe(authSessionKey({ ...base, home_tenant: 'One' }));
  });

  it('una revalidación sin autoridad conserva la ya decidida para la misma sesión y nunca la inventa', () => {
    const base: ConsoleAuthState = { authenticated: true, subject: 'miguel@example.test', csrf_token: 'csrf', authority: owner };
    const omitted: ConsoleAuthState = { authenticated: true, subject: 'miguel@example.test', csrf_token: 'csrf' };
    expect(revalidatedState(base, omitted)).toEqual(base);
    expect(authSessionKey(revalidatedState(base, omitted))).toBe(authSessionKey(base));
    const reader = { ...owner, role: 'reader', scope: 'tenant' } satisfies ConsoleAuthority;
    expect(revalidatedState(base, { ...omitted, authority: reader }).authority).toEqual(reader);
    expect(revalidatedState(base, { ...omitted, csrf_token: 'other' })).not.toHaveProperty('authority');
    expect(revalidatedState(base, { authenticated: false })).toEqual({ authenticated: false });
    expect(revalidatedState(undefined, omitted)).toBe(omitted);
  });
});

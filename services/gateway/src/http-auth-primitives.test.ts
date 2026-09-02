import { describe, expect, it } from 'vitest';
import {
  clearHostSessionCookie,
  constantTimeText,
  hasCookie,
  hostSessionCookie,
  isHostCookieName,
  scalarHeaderValue,
  uniqueCookieValue
} from './http-auth-primitives.js';

describe('HTTP authentication primitives', () => {
  it('reduces scalar headers with the existing first-value contract', () => {
    expect(scalarHeaderValue(undefined)).toBeUndefined();
    expect(scalarHeaderValue('one')).toBe('one');
    expect(scalarHeaderValue(['one', 'two'])).toBe('one');
    expect(scalarHeaderValue([])).toBeUndefined();
  });

  it('rejects duplicate and malformed cookie values without hiding their presence', () => {
    const name = '__Host-cauce_session';

    expect(uniqueCookieValue(`${name}=first; ${name}=second`, name)).toBeUndefined();
    expect(uniqueCookieValue(`${name}=%E0%A4%A`, name)).toBeUndefined();
    expect(hasCookie(`${name}=%E0%A4%A`, name)).toBe(true);
    expect(hasCookie(`${name}=first; ${name}=second`, name)).toBe(true);
  });

  it('matches the whole cookie name instead of a prefix or colliding name', () => {
    const name = '__Host-cauce_session';
    const header = '__Host-cauce_session_backup=wrong; __Host-cauce=short; __Host-cauce_session=right%20value';

    expect(uniqueCookieValue(header, name)).toBe('right value');
    expect(uniqueCookieValue('__Host-cauce_session_backup=wrong', name)).toBeUndefined();
    expect(hasCookie('__Host-cauce_session_backup=wrong', name)).toBe(false);
  });

  it('compares equal text and rejects different content or byte lengths', () => {
    expect(constantTimeText('same-value', 'same-value')).toBe(true);
    expect(constantTimeText('same-value', 'same-valuf')).toBe(false);
    expect(constantTimeText('short', 'longer')).toBe(false);
    expect(constantTimeText('ñ', 'n')).toBe(false);
  });

  it('serializes only __Host cookies with the requested SameSite contract', () => {
    expect(isHostCookieName('__Host-cauce_session')).toBe(true);
    expect(isHostCookieName('cauce_session')).toBe(false);
    expect(() => hostSessionCookie('cauce_session', 'value', 30, 'Strict')).toThrow(/__Host-/);

    expect(hostSessionCookie('__Host-cauce_session', 'value with spaces', 30.9, 'Strict')).toBe(
      '__Host-cauce_session=value%20with%20spaces; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=30'
    );
    expect(hostSessionCookie('__Host-cauce_login', 'value', 30, 'Lax')).toBe(
      '__Host-cauce_login=value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=30'
    );
    expect(clearHostSessionCookie('__Host-cauce_session', 'Strict')).toBe(
      '__Host-cauce_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
    );
  });
});

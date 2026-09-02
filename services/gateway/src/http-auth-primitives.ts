import { timingSafeEqual } from 'node:crypto';

export type CookieSameSite = 'Strict' | 'Lax';

const HOST_COOKIE_NAME = /^__Host-[A-Za-z0-9_-]+$/;

export function scalarHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function matchingCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
}

/** Rejects duplicate names instead of choosing one of two attacker-controlled cookie values. */
export function uniqueCookieValue(header: string | undefined, name: string): string | undefined {
  const values = matchingCookies(header, name);
  const [match] = values;
  if (values.length !== 1 || match === undefined) return undefined;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

/** Presence is intentionally independent from validity so a malformed browser cookie cannot enable bearer fallback. */
export function hasCookie(header: string | undefined, name: string): boolean {
  return matchingCookies(header, name).length > 0;
}

export function constantTimeText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isHostCookieName(name: string): boolean {
  return HOST_COOKIE_NAME.test(name);
}

function isCookieSameSite(value: unknown): value is CookieSameSite {
  return value === 'Strict' || value === 'Lax';
}

export function hostSessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  sameSite: CookieSameSite
): string {
  if (!isHostCookieName(name)) throw new Error('session cookie name must use the __Host- prefix');
  if (!isCookieSameSite(sameSite)) throw new Error('session cookie SameSite is invalid');
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${
    String(Math.max(0, Math.floor(maxAgeSeconds)))}`;
}

export function clearHostSessionCookie(name: string, sameSite: CookieSameSite): string {
  return hostSessionCookie(name, '', 0, sameSite);
}

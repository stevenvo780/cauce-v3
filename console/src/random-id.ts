/* `crypto.randomUUID` exists only in a secure context, so a console opened over plain HTTP on a LAN
   address does not have it and an unguarded call throws before React mounts, leaving a blank page.
   `getRandomValues` carries no such restriction: the fallback keeps the entropy rather than
   degrading to `Math.random`, and callers that need a fenced identifier still get one. */
export function randomUuid(): string {
  const source = globalThis.crypto as Crypto | undefined;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('Este navegador no ofrece una fuente de aleatoriedad para generar identificadores.');
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

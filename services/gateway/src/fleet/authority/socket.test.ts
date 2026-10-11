import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetAuthoritySocket } from './socket.js';

let directory: string | undefined;
let server: Awaited<ReturnType<typeof startFleetAuthoritySocket>> | undefined;
async function start(readiness?: () => Promise<void>) {
  directory = await mkdtemp('/var/tmp/cauce-authority-ready-');
  const unexpected = () => Promise.reject(new Error('Readiness cannot issue material'));
  server = await startFleetAuthoritySocket(join(directory, 'authority.sock'),
    { execute: unexpected, executeInTransaction: unexpected },
    { ownerUid: process.geteuid?.() ?? 0, host_id: 'host-a', ...(readiness ? { readiness } : {}) });
  return server;
}
afterEach(async () => {
  await server?.close(); server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined;
});
describe('closed legacy authority readiness route', () => {
  it('does not advertise readiness when the pinned issuer callback is absent', async () => {
    const app = await start();
    const response = await app.inject({ method: 'POST', url: '/authority-ready', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'AUTHORITY_UNAVAILABLE' });
  });
  it('requires a strict empty body and refuses cookie authority without running the issuer', async () => {
    let calls = 0;
    const app = await start(async () => { calls++; });
    for (const payload of ['{"action":"issue"}', 'null', '[]']) {
      const response = await app.inject({ method: 'POST', url: '/authority-ready', payload, headers: { 'content-type': 'application/json' } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'INVALID_REQUEST' });
    }
    const cookie = await app.inject({ method: 'POST', url: '/authority-ready', payload: {}, headers: { cookie: 'session=untrusted' } });
    expect(cookie.statusCode).toBe(403);
    expect(cookie.json()).toEqual({ error: 'AUTHORITY_REVOKED' });
    expect(calls).toBe(0);
    const ready = await app.inject({ method: 'POST', url: '/authority-ready', payload: {} });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true, host_id: 'host-a' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(calls).toBe(1);
  });
  it('returns only a generic failure when the issuer rejects its private configuration', async () => {
    const app = await start(() => Promise.reject(new Error('private issuer detail')));
    const response = await app.inject({ method: 'POST', url: '/authority-ready', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'AUTHORITY_UNAVAILABLE' });
  });
});

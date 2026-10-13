import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ApiError, CauceApi } from '../client';
import { MAX_SPACE_BACKUP_BYTES, spaceBackupReceipt, type SpaceBackup, type SpaceBackupTarget } from './space-backups-client';

const target: SpaceBackupTarget = { company_id: 'one', tenant_id: 'One', alias: 'agent' };
const id = '00000000-0000-4000-8000-000000000050'; const path = `/v3/console/spaces/One/agent/backups/${id}/download`;
const bytes = new Uint8Array([80, 75, 5, 6, ...Array<number>(18).fill(0)]);
const ready: SpaceBackup = { ...target, id, status: 'ready', sha256: createHash('sha256').update(bytes).digest('hex'),
  manifest_sha256: 'a'.repeat(64), bytes: bytes.length, error: null, download_url: path };
const auth = { authenticated: true, subject: 'owner@example.test', home_tenant: 'One', csrf_token: 'test-csrf', authority: { role: 'company_owner', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } };

it('valida target, hashes, límites y ruta exacta; failed expirado conserva metadata sin descarga', () => {
  expect(spaceBackupReceipt(ready, target)).toEqual(ready);
  expect(spaceBackupReceipt({ ...ready, status: 'running', download_url: null }, target)).toMatchObject({ status: 'running' });
  expect(spaceBackupReceipt({ ...ready, status: 'running', sha256: null, manifest_sha256: null, bytes: null, download_url: null }, target)).toMatchObject({ status: 'running' });
  expect(spaceBackupReceipt({ ...ready, status: 'failed', error: 'EXPIRED', download_url: null }, target)).toMatchObject({ error: 'EXPIRED' });
  expect(spaceBackupReceipt({ ...target, id, status: 'failed', error: 'LIMIT_EXCEEDED', sha256: null,
    manifest_sha256: null, bytes: null, download_url: null }, target)).toMatchObject({ error: 'LIMIT_EXCEEDED' });
  for (const patch of [{ company_id: 'other' }, { tenant_id: 'Other' }, { alias: 'other' }, { id: 'not-uuid' }, { sha256: 'invalid' },
    { bytes: MAX_SPACE_BACKUP_BYTES + 1 }, { status: 'pending' }, { download_url: 'https://evil.example/archive.zip' },
    { status: 'running', sha256: null, download_url: null }, { status: 'running', error: 'EXPORT_FAILED', download_url: null },
    { download_url: `${path}?redirect=other` }, { download_url: '/v3/console/spaces/Other/agent/backups/file/download' },
    { status: 'failed', error: 'PRIVATE_PATH', download_url: null }, { command: 'shell' }]) {
    expect(() => spaceBackupReceipt({ ...ready, ...patch }, target)).toThrow('No se pudo verificar');
  }
  expect(() => spaceBackupReceipt(ready, { ...target, tenant_id: '..' })).toThrow();
});
it('usa sesión+CSRF para crear y conserva el recibo; la descarga es un enlace sin cargar el ZIP', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; calls.push({ url, init });
    if (url.endsWith('/v3/auth/session')) return Response.json(auth);
    return Response.json(ready, { status: 202 });
  });
  const api = new CauceApi('https://console.example', fetcher); await api.getAuthSession();
  expect(await api.createSpaceBackup(target, 'stable_request')).toEqual(ready);
  const create = calls.find(call => call.init?.method === 'POST');
  expect(create?.init).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': 'test-csrf' } });
  expect(create?.init?.body).toBe(JSON.stringify({ idempotency_key: 'stable_request' }));
  expect(api.spaceBackupDownloadUrl(ready)).toBe(`https://console.example${path}`);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('acepta un recibo y un estado de 100 MiB, hasta el límite de 1 GiB del backend', () => {
  const big = { ...ready, bytes: 100 * 1024 * 1024 };
  expect(MAX_SPACE_BACKUP_BYTES).toBe(1024 * 1024 * 1024);
  expect(spaceBackupReceipt(big, target)).toEqual(big);
  expect(spaceBackupReceipt({ ...big, bytes: MAX_SPACE_BACKUP_BYTES }, target).bytes).toBe(MAX_SPACE_BACKUP_BYTES);
  const api = new CauceApi('https://console.example', async () => Response.json(big));
  return expect(api.getSpaceBackup(target, id)).resolves.toEqual(big);
});
it('no ofrece enlace de descarga para un recibo que no está ready', () => {
  const api = new CauceApi('https://console.example', async () => Response.json(auth));
  expect(() => api.spaceBackupDownloadUrl({ ...ready, status: 'running', download_url: null })).toThrow();
});
it('la descarga verificable devuelve el cuerpo sin cargarlo, con sesión y sin CSRF, y rechaza un tamaño ajeno al recibo', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const respond = (length: string) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; calls.push({ url, ...(init ? { init } : {}) });
    return new Response(bytes.slice(), { headers: { 'content-type': 'application/zip', 'content-length': length } });
  });
  const api = new CauceApi('https://console.example', respond(String(bytes.length)));
  const body = await api.downloadSpaceBackup(ready, new AbortController().signal);
  expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(bytes);
  expect(calls[0]?.url).toBe(`https://console.example${path}`);
  expect(calls[0]?.init).toMatchObject({ credentials: 'include', cache: 'no-store', method: 'GET' });
  expect(calls[0]?.init?.headers).not.toHaveProperty('X-CSRF-Token');
  await expect(new CauceApi('https://console.example', respond('999')).downloadSpaceBackup(ready, new AbortController().signal))
    .rejects.toThrow('No se pudo verificar');
  await expect(api.downloadSpaceBackup({ ...ready, status: 'running', download_url: null }, new AbortController().signal))
    .rejects.toThrow('No se pudo verificar');
});
it('rechaza y cancela el stream de una respuesta tardía cuando cambió la sesión', async () => {
  let release: () => void = () => undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; }); const cancel = vi.fn();
  const api = new CauceApi('https://console.example', async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/download')) {
      await delayed;
      return new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(bytes.length) } });
    }
    return Response.json(auth);
  });
  const result = api.downloadSpaceBackup(ready, new AbortController().signal).then(() => ({ code: 'accepted' }),
    (error: unknown) => ({ code: error instanceof ApiError ? error.code : String(error) }));
  await api.login('zz-canary@example.test', 'zz-canary-test-password'); release();
  expect(await result).toEqual({ code: 'session_changed' }); expect(cancel).toHaveBeenCalledOnce();
});

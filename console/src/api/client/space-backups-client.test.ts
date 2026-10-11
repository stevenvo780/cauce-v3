import { Blob as NodeBlob } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CauceApi } from '../client';
import { MAX_SPACE_BACKUP_BYTES, spaceBackupReceipt, type SpaceBackup, type SpaceBackupTarget } from './space-backups-client';

const target: SpaceBackupTarget = { company_id: 'one', tenant_id: 'One', alias: 'agent' };
const id = '00000000-0000-4000-8000-000000000050'; const path = `/v3/console/spaces/One/agent/backups/${id}/download`;
const bytes = new Uint8Array([80, 75, 5, 6, ...Array<number>(18).fill(0)]);
const ready: SpaceBackup = { ...target, id, status: 'ready', sha256: createHash('sha256').update(bytes).digest('hex'),
  manifest_sha256: 'a'.repeat(64), bytes: bytes.length, error: null, download_url: path };
const auth = { authenticated: true, subject: 'owner@example.test', home_tenant: 'One', csrf_token: 'test-csrf', authority: { role: 'company_owner', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } };
beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); });

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
it('usa sesión+CSRF para crear, conserva recibo y descarga ZIP verificado sin redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; calls.push({ url, init });
    if (url.endsWith('/v3/auth/session')) return Response.json(auth);
    if (url.endsWith('/download')) return new Response(bytes, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } });
    return Response.json(ready, { status: 202 });
  });
  const api = new CauceApi('https://console.example', fetcher); await api.getAuthSession();
  expect(await api.createSpaceBackup(target, 'stable_request')).toEqual(ready);
  const create = calls.find(call => call.init?.method === 'POST');
  expect(create?.init).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': 'test-csrf' } });
  expect(create?.init?.body).toBe(JSON.stringify({ idempotency_key: 'stable_request' }));
  const blob = await api.downloadSpaceBackup(ready); expect(blob.size).toBe(bytes.length);
  expect(calls.at(-1)?.url).toBe(`https://console.example${path}`);
  expect(calls.at(-1)?.init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/zip' } });
});
it.each(['type', 'hash', 'size', 'limit'] as const)('rechaza descarga defectuosa: %s', async failure => {
  const response = new Response(bytes, { headers: { 'Content-Type': failure === 'type' ? 'text/html' : 'application/zip',
    'Content-Length': failure === 'limit' ? String(MAX_SPACE_BACKUP_BYTES + 1) : String(bytes.length) } });
  const api = new CauceApi('https://console.example', async () => response);
  await expect(api.downloadSpaceBackup({ ...ready, ...(failure === 'hash' ? { sha256: 'b'.repeat(64) } : {}),
    ...(failure === 'size' ? { bytes: bytes.length + 1 } : {}) })).rejects.toThrow();
});
it.each(['company', 'tenant', 'scope'] as const)('rechaza la descarga en vuelo si cambia la autoridad de sesión: %s', async change => {
  let release: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); release = () => { controller.close(); }; } });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith('/download')
    ? new Response(stream, { headers: { 'Content-Type': 'application/zip' } }) : Response.json(auth));
  const api = new CauceApi('https://console.example', fetcher); await api.getAuthSession();
  const downloading = api.downloadSpaceBackup(ready); await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
  fetcher.mockImplementation(async () => Response.json({ ...auth, ...(change === 'tenant' ? { home_tenant: 'Other' } : {}),
    authority: { ...auth.authority, ...(change === 'company' ? { acting_company: 'other' } : {}), ...(change === 'scope' ? { scope: 'none' } : {}) } }));
  await api.getAuthSession(); release?.(); await expect(downloading).rejects.toThrow('La sesión cambió');
});

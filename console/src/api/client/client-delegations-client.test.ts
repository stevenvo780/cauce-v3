import { expect, it, vi } from 'vitest';
import { CauceApi } from '../client';
import { clientDelegationsClient, clientDeclarationLabel, clientDeclarationReference, clientDeclarationUuid, clientDeclarationResponse, clientConnectionsResponse } from './client-delegations-client';
import { ClientDelegationLabelSchema, Sha256HexSchema, CanonicalUuidV4Schema } from '@cauce/protocol';
import type { RequestFn } from './system-client';

const id = '11111111-1111-4111-8111-111111111111';
const ref = 'a'.repeat(64);
const path = '/v3/console/mcp/client-delegations';
const result = { binding_id: id, connection_ref: ref, owner_human_id: id, owner_tenant_id: 'Steven',
  label: 'Dots', display_label: 'Dots por cuenta de Steven', basis: 'owner_declared_grant', instance: 'unknown', revoked: false };

it('keeps browser validators aligned with the server UUID, reference and label schemas', () => {
  for (const [parse, schema, cases] of [
    [clientDeclarationLabel, ClientDelegationLabelSchema, ['Dots', 'Dots 2', 'a', 'a'.repeat(128), 'a'.repeat(129),
      'Dots.v2_x-y', '', ' Dots', 'Dots ', 'Dots\n', 'Dots\u0000', '<script>', 'Do\u0301ts', 'Dóts']],
    [clientDeclarationReference, Sha256HexSchema, [ref, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]],
    [clientDeclarationUuid, CanonicalUuidV4Schema, [id, id.replace('11111111', 'AAAAAAAA'), id.replace('-4111-', '-5111-'), 'invalid']],
  ] as const) {
    for (const value of cases) {
      if (schema.safeParse(value).success) expect(parse(value)).toBe(value);
      else expect(() => parse(value)).toThrow();
    }
  }
});

it('sends only the strict create/rename/revoke fields and uses no-store for the list', async () => {
  const request = vi.fn().mockResolvedValue(result).mockResolvedValueOnce({ items: [], truncated: false }) as unknown as RequestFn;
  const api = clientDelegationsClient(request);
  await api.listClientConnections();
  await api.createClientDeclaration({ request_id: id, connection_ref: ref, label: 'Dots', extra: 'discarded' } as Parameters<typeof api.createClientDeclaration>[0]);
  await api.renameClientDeclaration(id, { request_id: id, label: 'Dots v2' });
  await api.revokeClientDeclaration(id, { request_id: id, label: 'discarded' } as Parameters<typeof api.revokeClientDeclaration>[1]);
  expect(request).toHaveBeenNthCalledWith(1, path, { cache: 'no-store' });
  expect(request).toHaveBeenNthCalledWith(2, path, { method: 'POST', body: JSON.stringify({ request_id: id, connection_ref: ref, label: 'Dots' }) });
  expect(request).toHaveBeenNthCalledWith(3, `${path}/${id}/rename`, { method: 'POST', body: JSON.stringify({ request_id: id, label: 'Dots v2' }) });
  expect(request).toHaveBeenNthCalledWith(4, `${path}/${id}/revoke`, { method: 'POST', body: JSON.stringify({ request_id: id }) });
});

it('uses the existing cookie/CSRF request path for every mutation', async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify((typeof url === 'string'
    ? url : url instanceof URL ? url.href : url.url).endsWith('/v3/auth/session')
    ? { authenticated: true, subject: 'owner', csrf_token: 'fixture-csrf', login_mode: 'password' } : result),
  { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const api = new CauceApi('http://localhost', fetcher, undefined);
  await api.createClientDeclaration({ request_id: id, connection_ref: ref, label: 'Dots' });
  await api.renameClientDeclaration(id, { request_id: id, label: 'Dots 2' });
  await api.revokeClientDeclaration(id, { request_id: id });
  const calls = vi.mocked(fetcher).mock.calls as unknown as [string, RequestInit][];
  for (const [, init] of calls.filter(([url]) => url.startsWith(`http://localhost${path}`))) {
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'fixture-csrf', 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('Authorization');
  }
});

it.each([401, 403, 404, 409])('propagates %s without retry or changing the request key', async status => {
  const request = vi.fn().mockRejectedValue(new Error(String(status))) as unknown as RequestFn;
  await expect(clientDelegationsClient(request).createClientDeclaration({ request_id: id, connection_ref: ref, label: 'Dots' })).rejects.toThrow(String(status));
  expect(request).toHaveBeenCalledOnce();
});

it('rejects invalid UUIDs, references and labels before requesting', () => {
  const request = vi.fn() as unknown as RequestFn;
  const api = clientDelegationsClient(request);
  for (const input of [{ request_id: 'invalid', connection_ref: ref, label: 'Dots' },
    { request_id: id, connection_ref: 'short', label: 'Dots' }, { request_id: id, connection_ref: ref, label: '<img>' }]) {
    expect(() => api.createClientDeclaration(input)).toThrow();
  }
  expect(() => api.renameClientDeclaration('../bad', { request_id: id, label: 'Dots' })).toThrow();
  expect(request).not.toHaveBeenCalled();
});

it.each([null, [], {}, { ...result, binding_id: 'invalid' }, { ...result, revoked: 'false' },
  { ...result, connection_ref: 'g'.repeat(64) }, { ...result, instance: 'verified' },
  { ...result, owner_human_id: 'owner' }, { ...result, owner_tenant_id: '' },
  { ...result, display_label: 'unrelated' }])('rejects malformed successful mutation response %j', value => {
  expect(() => clientDeclarationResponse(value)).toThrow('no confirma');
});
it.each([null, {}, { items: [], truncated: 'false' }, { items: [{}], truncated: false },
  { items: Array.from({ length: 101 }, () => ({})), truncated: true }])('rejects malformed list response %j', value => {
  expect(() => clientConnectionsResponse(value)).toThrow('no confirma');
});
it('does not turn a malformed 2xx acknowledgement into success or retry it automatically', async () => {
  const request = vi.fn().mockResolvedValue({}) as unknown as RequestFn;
  await expect(clientDelegationsClient(request).createClientDeclaration({ request_id: id, connection_ref: ref, label: 'Dots' })).rejects.toThrow('no confirma');
  expect(request).toHaveBeenCalledOnce();
});

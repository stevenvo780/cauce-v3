import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client/core';
import type { ClientConnection } from '../../api/types/client-delegations';
import { declarationError, grantActive, prepareDeclaration, selectedConnection, sendDeclaration, uncertainDeclaration, verifiedConnection, confirmDeclarationResult } from './client-declaration-state';

const id = '11111111-1111-4111-8111-111111111111';
const connection: ClientConnection = { connection_ref: 'a'.repeat(64), client_id: 'same-client',
  created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked: false,
  binding_id: null, label: null, display_label: null, basis: 'owner_declared_grant', instance: 'unknown',
  last_publication_at: null, last_use_at: null, last_use_observed: false };

describe('exact owner declaration state', () => {
  it('never selects a fallback for absent, stale, duplicate or truncated references', () => {
    const page = { items: [connection, { ...connection, connection_ref: 'b'.repeat(64) }], truncated: true };
    expect(selectedConnection(page, '')).toBeUndefined();
    expect(selectedConnection(page, 'old')).toBeUndefined();
    expect(selectedConnection(page, connection.connection_ref)).toBe(connection);
    expect(selectedConnection({ ...page, items: [connection, connection] }, connection.connection_ref)).toBeUndefined();
    expect(() => prepareDeclaration('create', undefined, 'Dots', id)).toThrow();
  });
  it.each(['', ' Dots', 'Dots ', '<script>', 'a'.repeat(129), 'Dóts', 'Dots\n', 'Dots\u0000'])('rejects hostile or invalid label %j', label => {
    expect(() => prepareDeclaration('create', connection, label, id)).toThrow();
  });
  it.each(['Dots', 'Dots 2', 'Dots.v2_test-x'])('preserves valid label exactly %s', label => {
    expect(prepareDeclaration('create', connection, label, id)).toEqual({ operation: 'create',
      input: { request_id: id, connection_ref: connection.connection_ref, label } });
  });
  it('enforces expiry including boundary and leaves removal of an expired declaration possible', () => {
    const expired = { ...connection, expires_at: new Date(1000).toISOString(), binding_id: id, label: 'Dots' };
    expect(grantActive(expired, 999)).toBe(true);
    expect(grantActive(expired, 1000)).toBe(false);
    for (const row of [expired, { ...connection, revoked: true }, { ...connection, expires_at: 'invalid' }]) {
      expect(() => prepareDeclaration('create', row, 'Dots', id)).toThrow();
    }
    expect(prepareDeclaration('revoke', expired, 'ignored', id)).toEqual({ operation: 'revoke', bindingId: id, connectionRef: connection.connection_ref, expectedLabel: 'Dots', input: { request_id: id } });
  });
  it('freezes request identity and body for an identical manual retry', async () => {
    const command = prepareDeclaration('rename', { ...connection, binding_id: id }, 'Dots v2', id);
    const api = { listClientConnections: vi.fn(), createClientDeclaration: vi.fn(),
      renameClientDeclaration: vi.fn().mockResolvedValue({}), revokeClientDeclaration: vi.fn() };
    await sendDeclaration(api, command); await sendDeclaration(api, command);
    expect(api.renameClientDeclaration.mock.calls).toEqual([[id, { request_id: id, label: 'Dots v2' }], [id, { request_id: id, label: 'Dots v2' }]]);
    expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.input)).toBe(true);
  });
  it('distinguishes uncertain responses from conflicts and definitive authorization failures', () => {
    expect(uncertainDeclaration(new TypeError('response lost'))).toBe(true);
    expect(uncertainDeclaration(new ApiError('timeout', 504))).toBe(true);
    for (const status of [401, 403, 404, 409]) {
      const cause = new ApiError('fixture', status);
      expect(uncertainDeclaration(cause)).toBe(false);
      expect(declarationError(cause)).not.toBe('fixture');
    }
  });
});

it('accepts exactly one pasted reference among 100 same-client grants and rejects malformed, absent and duplicate refs', () => {
  const page = { items: Array.from({ length: 100 }, (_, i) => ({ ...connection, connection_ref: i.toString(16).padStart(64, '0') })), truncated: true };
  expect(verifiedConnection(page, page.items[99].connection_ref)).toBe(page.items[99]);
  for (const reference of ['', 'A'.repeat(64), ` ${page.items[99].connection_ref}`, 'g'.repeat(64)]) expect(() => verifiedConnection(page, reference)).toThrow('exactamente');
  expect(() => verifiedConnection(page, connection.connection_ref)).toThrow('100 conexiones');
  expect(() => verifiedConnection({ ...page, truncated: false }, connection.connection_ref)).toThrow('no se encontró');
  expect(() => verifiedConnection({ items: [connection, connection], truncated: false }, connection.connection_ref)).toThrow('ambigua');
});
it('confirms acknowledgement structure and exact command correlation for every operation', () => {
  const freshId = '22222222-2222-4222-8222-222222222222';
  const result = { binding_id: freshId, connection_ref: connection.connection_ref, owner_human_id: id, owner_tenant_id: 'Steven',
    label: 'Dots', display_label: 'Dots por cuenta de Steven', basis: 'owner_declared_grant', instance: 'unknown', revoked: false };
  for (const operation of ['create', 'rename', 'revoke'] as const) {
    const command = prepareDeclaration(operation, operation === 'create' ? connection : { ...connection, binding_id: id, label: 'Dots' }, 'Dots', id);
    const valid = { ...result, binding_id: operation === 'revoke' ? id : freshId, revoked: operation === 'revoke' };
    expect(confirmDeclarationResult(command, valid)).toEqual(valid);
    for (const bad of [{}, { ...valid, connection_ref: 'b'.repeat(64) }, { ...valid, label: 'Other', display_label: 'Other por cuenta de Steven' },
      { ...valid, revoked: !valid.revoked }]) expect(() => confirmDeclarationResult(command, bad)).toThrow('no confirma');
    if (operation !== 'create') expect(() => confirmDeclarationResult(command, { ...valid, binding_id: operation === 'revoke' ? freshId : id })).toThrow('no confirma');
  }
});

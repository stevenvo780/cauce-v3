import { expect, it } from 'vitest';
import type { NativeAdminClient } from './client';
import { readNativeDraft, storeNativeDraft, type NativeDraft } from './drafts';

function fixture() {
  const api = { nativeAdminEpoch: () => 0 } as NativeAdminClient;
  const draft: NativeDraft = { kind: 'skill', id: 'native-proof', content: 'Draft.', url: '', env: '', reason: 'Guardar pieza con evidencia' };
  const pending: NativeDraft = { ...draft, pending: { operationId: '00000000-0000-4000-8000-000000000061',
    mutation: { kind: 'skill', id: 'native-proof', action: 'put', expected_sha: null, value: { content: 'Draft.' } },
    identity: { generation: 'fixture-generation', container_id: 'fixture-container', writer_instance_id: '00000000-0000-4000-8000-000000000062' } } };
  return { api, draft, pending };
}
it('conserva la primera operación pendiente al abrir veinte borradores posteriores', () => {
  const { api, draft, pending } = fixture(); storeNativeDraft(api, 'Steven', 'pending-first', pending);
  for (let index = 0; index < 20; index += 1) storeNativeDraft(api, 'Steven', `normal-${String(index)}`, draft);
  expect(readNativeDraft(api, 'Steven', 'pending-first')).toEqual(pending);
  expect(readNativeDraft(api, 'Steven', 'normal-0')).toEqual(draft);
});
it('aplica el tope sólo a borradores descartables y conserva todos los IDs, mutations e identidades pendientes', () => {
  const { api, draft, pending } = fixture();
  for (let index = 0; index < 21; index += 1) storeNativeDraft(api, 'Steven', `pending-${String(index)}`, pending);
  for (let index = 0; index < 21; index += 1) storeNativeDraft(api, 'Steven', `normal-${String(index)}`, draft);
  for (let index = 0; index < 21; index += 1) expect(readNativeDraft(api, 'Steven', `pending-${String(index)}`)).toEqual(pending);
  expect(readNativeDraft(api, 'Steven', 'normal-0')).toBeUndefined();
  expect(readNativeDraft(api, 'Steven', 'normal-1')).toEqual(draft); expect(readNativeDraft(api, 'Steven', 'normal-20')).toEqual(draft);
});

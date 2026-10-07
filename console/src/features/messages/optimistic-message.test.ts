import { expect, it } from 'vitest';
import { mergeOptimisticMessages, optimisticMessageOf, type OptimisticMessage } from './optimistic-message';

function local(clientId: string): OptimisticMessage {
  return { optimistic: { clientId, state: 'published', files: [new File(['file'], 'archivo.txt', { type: 'text/plain' })] },
    direction: 'input', message: { message_id: clientId, body_preview: 'texto completo', created_at: new Date().toISOString() },
    delivery: { delivery_id: `${clientId}-delivery`, recipient_tenant: 'Empresa', recipient_alias: 'agente' } };
}

it('acota el cache optimista a los cien mensajes más recientes', () => {
  const items = Array.from({ length: 101 }, (_, index) => local(String(index)));
  const merged = mergeOptimisticMessages([], items);
  expect(merged).toHaveLength(100);
  expect(merged.some((item) => optimisticMessageOf(item)?.clientId === '0')).toBe(false);
});

it('suelta referencias a Files cuando el feed canónico ya incluye los adjuntos, conservando texto completo', () => {
  const item = local('message');
  const remote = { ...item, message: { ...item.message, body_preview: 'preview', attachments: [
    { name: 'archivo.txt', mime_type: 'text/plain', file_size: 4, sha256: 'a'.repeat(64) },
  ] } };
  const merged = mergeOptimisticMessages([remote], [item]);
  expect(merged).toHaveLength(1);
  const first = merged.at(0);
  if (!first) throw new Error('missing merged message');
  expect(optimisticMessageOf(first)?.files).toHaveLength(0);
  expect(first.message.body_preview).toBe('texto completo');
});

it('una entrega de otro tenant no consume el snapshot local aunque comparta IDs', () => {
  const item = local('message');
  const remote = { ...item, optimistic: undefined, delivery: { ...item.delivery, recipient_tenant: 'Otra' } };
  const merged = mergeOptimisticMessages([remote], [item]);
  expect(merged).toHaveLength(2);
  const kept = merged.find((entry) => entry.delivery?.recipient_tenant === 'Empresa');
  if (!kept) throw new Error('missing scoped message');
  expect(optimisticMessageOf(kept)?.files).toHaveLength(1);
});

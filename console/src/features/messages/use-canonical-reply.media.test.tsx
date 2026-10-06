import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../api/context';
import { testApi } from '../../test/render';
import { canonicalReplyMedia } from './canonical-reply-media';
import { useCanonicalReply } from './use-canonical-reply';

const file = { name: 'respuesta.wav', mime_type: 'audio/wav', file_size: 48, sha256: 'a'.repeat(64) };
const mediaDeliveryId = 'cccccccc-1111-4111-8111-cccccccccccc';
const media = { reply_attachments: [file], reply_attachment_delivery_id: mediaDeliveryId, reply_attachment_attempt: 2 };

function wrapper({ children }: { children: ReactNode }) {
  return <ApiProvider api={testApi}>{children}</ApiProvider>;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('consolida una respuesta con sólo archivo y deja de esperar una respuesta de texto', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'media-root', chain_open: false,
    deliveries: [{ delivery_id: 'root-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: null, ...media }],
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'human-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'media-root', deliveryId: 'root-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply).toMatchObject({
    reply: null, replyAttachments: [file], replyAttachmentDeliveryId: mediaDeliveryId, replyAttachmentAttempt: 2,
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
  expect(getMessage).toHaveBeenCalledOnce();
  unmount();
});

it.each([
  { reply_attachments: [file], reply_attachment_attempt: 2 },
  { ...media, reply_attachment_delivery_id: 'otra-publicacion' },
  { ...media, reply_attachment_attempt: -1 },
  { ...media, reply_attachment_attempt: 1.5 },
  { ...media, reply_attachments: [{ ...file, sha256: 'incorrecto' }] },
  { ...media, reply_attachments: [{ ...file, file_size: 10_000_001 }] },
])('rechaza archivos sin una identidad de entrega e intento válida: %j', (candidate) => {
  expect(() => canonicalReplyMedia(candidate)).toThrow();
});

it('conserva compatibilidad con respuestas antiguas sin adjuntos y no publica bytes o URIs', () => {
  expect(canonicalReplyMedia({ reply: 'respuesta anterior' })).toEqual({});
  expect(canonicalReplyMedia({ ...media, reply_attachments: [] })).toEqual({});
  const projected = canonicalReplyMedia({ ...media, reply_attachments: [{ ...file, ...{ content_base64: 'QUJD', uri: 'data:audio/wav;base64,QUJD' } }] });
  expect(JSON.stringify(projected)).not.toContain('base64');
  expect(JSON.stringify(projected)).not.toContain('data:');
});

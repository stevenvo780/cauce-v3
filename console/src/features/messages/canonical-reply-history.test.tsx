import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../api/context';
import { ApiError } from '../../api/client';
import type { MessageDetail } from '../../api/types';
import { testApi } from '../../test/render';
import { useCanonicalReply, type CanonicalReplyRoot } from './use-canonical-reply';

const a = { messageId: 'a', deliveryId: 'da', status: 'done' as const };
const b = { messageId: 'b', deliveryId: 'db', status: 'done' as const };
const input = { publisherSubject: 'human', tenantId: 'tenant', alias: 'agent' };
function detail(root: CanonicalReplyRoot, text = root.messageId) {
  return { message_id: root.messageId, chain_open: false,
    deliveries: [{ delivery_id: root.deliveryId, tenant_id: 'tenant', alias: 'agent', status: 'done' as const, reply: text }] };
}
function wrapper({ children }: { children: ReactNode }) { return <ApiProvider api={testApi}>{children}</ApiProvider>; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('conserva ambas respuestas al enviar y seleccionar otra raíz', async () => {
  vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => detail(id === 'a' ? a : b));
  const initialProps: { root?: CanonicalReplyRoot } = { root: a };
  const { result, rerender } = renderHook(({ root }: { root?: CanonicalReplyRoot }) => useCanonicalReply({ ...input, root }),
    { wrapper, initialProps });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.reply)).toEqual(['a']); });
  rerender({ root: undefined });
  expect(result.current.replies.map((reply) => reply.reply)).toEqual(['a']);
  rerender({ root: b });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.reply)).toEqual(['a', 'b']); });
  rerender({ root: a });
  await waitFor(() => { expect(result.current.reply?.messageId).toBe('a'); });
  expect(result.current.replies).toHaveLength(2);
});

it('recupera las raíces propias al recargar con lecturas secuenciales y sin duplicados', async () => {
  let inFlight = 0;
  let maximum = 0;
  const get = vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    inFlight += 1; maximum = Math.max(maximum, inFlight);
    await Promise.resolve(); inFlight -= 1;
    return detail(id === 'a' ? a : b);
  });
  const { result } = renderHook(() => useCanonicalReply({ ...input, roots: [a, b, a] }), { wrapper });
  await waitFor(() => { expect(result.current.replies).toHaveLength(2); });
  expect(maximum).toBe(1);
  expect(get.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
});

it.each([401, 403, 404])('elimina una raíz revocada con %s y conserva las demás', async (status) => {
  const get = vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => detail(id === 'a' ? a : b));
  const { result, rerender } = renderHook(({ root }) => useCanonicalReply({ ...input, root }),
    { wrapper, initialProps: { root: a } });
  await waitFor(() => { expect(result.current.replies).toHaveLength(1); });
  rerender({ root: b });
  await waitFor(() => { expect(result.current.replies).toHaveLength(2); });
  get.mockRejectedValue(new ApiError('revoked', status));
  rerender({ root: a });
  await waitFor(() => { expect(result.current.accessDenied).toBe(true); });
  expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']);
});

it('conserva respuesta y archivos consolidados durante error 500 sin aceptar texto parcial posterior', async () => {
  const get = vi.spyOn(testApi, 'getMessage').mockResolvedValue(detail(a));
  const { result } = renderHook(() => useCanonicalReply({ ...input, root: a }), { wrapper });
  await waitFor(() => { expect(result.current.replies).toHaveLength(1); });
  get.mockRejectedValue(new ApiError('transient', 500));
  act(() => { result.current.retry(); });
  await waitFor(() => { expect(result.current.stale).toBe(true); });
  expect(result.current.replies[0]?.reply).toBe('a');
  get.mockResolvedValue({ ...detail(a, 'partial'), chain_open: true });
  act(() => { result.current.retry(); });
  await waitFor(() => { expect(result.current.reply?.chainOpen).toBe(true); });
  expect(result.current.replies[0]?.reply).toBe('a');
});

it('descarta el resultado diferido de otro humano aunque coincidan tenant y alias', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void;
  vi.spyOn(testApi, 'getMessage').mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ subject }) => useCanonicalReply({ ...input, publisherSubject: subject, root: a }), {
    wrapper, initialProps: { subject: 'human' },
  });
  await waitFor(() => { expect(resolve).toBeTypeOf('function'); });
  rerender({ subject: 'other-human' });
  await act(async () => { resolve(detail(a)); });
  expect(result.current.replies).toEqual([]);
});

it('limpia la historia al cambiar de API con el mismo humano, tenant y agente', async () => {
  vi.spyOn(testApi, 'getMessage').mockResolvedValue(detail(a));
  let api = testApi;
  const otherApi = Object.create(testApi) as typeof testApi;
  otherApi.getMessage = vi.fn().mockRejectedValue(new ApiError('unavailable', 500));
  const { result, rerender } = renderHook(() => useCanonicalReply({ ...input, root: a }), {
    wrapper: ({ children }: { children: ReactNode }) => <ApiProvider api={api}>{children}</ApiProvider>,
  });
  await waitFor(() => { expect(result.current.replies).toHaveLength(1); });
  api = otherApi;
  rerender();
  expect(result.current.replies).toEqual([]);
  await waitFor(() => { expect(result.current.error).toBeDefined(); });
  expect(result.current.replies).toEqual([]);
});

it('recupera una final anterior tras más de tres lecturas abiertas mientras otra raíz es la activa', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const get = vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    if (id !== 'a') return detail(b);
    reads += 1;
    return reads <= 4 ? { ...detail(a, 'parcial'), chain_open: true } : detail(a, 'final tardía');
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({ ...input, root: b, roots: [a, b] }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads).toBeGreaterThan(3);
  expect(result.current.replies.map((reply) => reply.reply)).toContain('final tardía');
  expect(result.current.replies.some((reply) => reply.reply === 'parcial')).toBe(false);
  const count = get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(get).toHaveBeenCalledTimes(count);
  unmount();
});

it('recupera una final done vacía anterior dentro de la misma ventana de 120 segundos', async () => {
  vi.useFakeTimers();
  let reads = 0;
  vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    if (id !== 'a') return detail(b);
    return detail(a, ++reads <= 4 ? '' : 'final tras cierre');
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({ ...input, root: b, roots: [a, b] }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_500); });
  expect(result.current.replies.map((reply) => reply.reply)).toContain('final tras cierre');
  unmount();
});

it('conserva archivos canónicos añadidos a una final cuando cambia la raíz activa', async () => {
  const get = vi.spyOn(testApi, 'getMessage').mockResolvedValue(detail(a));
  const { result, rerender } = renderHook(({ root }) => useCanonicalReply({ ...input, root }), { wrapper, initialProps: { root: a } });
  await waitFor(() => { expect(result.current.replies).toHaveLength(1); });
  const media = { name: 'respuesta.png', mime_type: 'image/png', file_size: 12, sha256: 'a'.repeat(64) };
  const withMedia = detail(a);
  get.mockResolvedValue({ ...withMedia, deliveries: [{ ...withMedia.deliveries[0], reply_attachments: [media],
    reply_attachment_delivery_id: 'a0000000-0000-4000-8000-000000000001', reply_attachment_attempt: 1 }] });
  act(() => { result.current.retry(); });
  await waitFor(() => { expect(result.current.replies[0]?.replyAttachments).toEqual([media]); });
  get.mockResolvedValue(detail(b));
  rerender({ root: b });
  await waitFor(() => { expect(result.current.replies).toHaveLength(2); });
  expect(result.current.replies[0]?.replyAttachments).toEqual([media]);
});

it('descarta un resultado diferido al cambiar y volver al mismo ámbito humano', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void;
  vi.spyOn(testApi, 'getMessage').mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ subject }) => useCanonicalReply({ ...input, publisherSubject: subject, root: a }), {
    wrapper, initialProps: { subject: 'human' },
  });
  await waitFor(() => { expect(resolve).toBeTypeOf('function'); });
  rerender({ subject: 'other-human' });
  rerender({ subject: 'human' });
  await act(async () => { resolve(detail(a, 'resultado de la época anterior')); });
  expect(result.current.replies).toEqual([]);
});

it('una hidratación anterior no resucita la raíz revocada por un 403 posterior y permite un nuevo retry autorizado', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void;
  let first = true;
  const get = vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    if (id === 'b') return detail(b);
    if (first) { first = false; return new Promise((done) => { resolve = done; }); }
    throw new ApiError('revoked', 403);
  });
  const { result, rerender } = renderHook(({ root }) => useCanonicalReply({ ...input, root, roots: [a, b] }), {
    wrapper, initialProps: { root: b },
  });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']); });
  rerender({ root: a });
  await waitFor(() => { expect(result.current.accessDenied).toBe(true); });
  await act(async () => { resolve(detail(a, 'histórica sin autoridad actual')); });
  expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']);
  get.mockResolvedValue(detail(a, 'retry autorizado'));
  act(() => { result.current.retry(); });
  await waitFor(() => { expect(result.current.accessDenied).toBe(false); });
  expect(result.current.replies.map((reply) => reply.reply)).toContain('retry autorizado');
});

it('un rechazo histórico fuera de orden no elimina la final de una lectura posterior autorizada', async () => {
  let reject!: (reason: unknown) => void;
  let first = true;
  vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    if (id === 'b') return detail(b);
    if (first) { first = false; return new Promise((_resolve, fail) => { reject = fail; }); }
    return detail(a, 'autorizada posterior');
  });
  const { result, rerender } = renderHook(({ root }) => useCanonicalReply({ ...input, root, roots: [a, b] }), {
    wrapper, initialProps: { root: b },
  });
  await waitFor(() => { expect(result.current.replies).toHaveLength(1); });
  rerender({ root: a });
  await waitFor(() => { expect(result.current.reply?.reply).toBe('autorizada posterior'); });
  await act(async () => { reject(new ApiError('old denial', 403)); });
  expect(result.current.replies.map((reply) => reply.reply)).toContain('autorizada posterior');
});

it('recupera ambas respuestas tras recargar en StrictMode con una hidratación histórica diferida', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void;
  vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => id === 'a'
    ? new Promise((done) => { resolve = done; }) : detail(b));
  const { result } = renderHook(() => useCanonicalReply({ ...input, root: b, roots: [a, b] }), {
    wrapper, reactStrictMode: true,
  });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']); });
  await act(async () => { resolve(detail(a, 'anterior tras recarga')); });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.messageId).sort()).toEqual(['a', 'b']); });
});

it('mantiene el fence de revocación en StrictMode frente a la hidratación anterior', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void;
  let first = true;
  vi.spyOn(testApi, 'getMessage').mockImplementation(async (id) => {
    if (id === 'b') return detail(b);
    if (first) { first = false; return new Promise((done) => { resolve = done; }); }
    throw new ApiError('revoked', 403);
  });
  const { result, rerender } = renderHook(({ root }) => useCanonicalReply({ ...input, root, roots: [a, b] }), {
    initialProps: { root: b },
    wrapper, reactStrictMode: true,
  });
  await waitFor(() => { expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']); });
  rerender({ root: a });
  await waitFor(() => { expect(result.current.accessDenied).toBe(true); });
  await act(async () => { resolve(detail(a, 'anterior revocada')); });
  expect(result.current.replies.map((reply) => reply.messageId)).toEqual(['b']);
});

it.each([0, { kind: 'agent', subject_id: 'human' }, { kind: 'human', subject_id: 'another-human' }])(
  'rechaza una autoría histórica no humana, malformada o ajena: %j', async (author) => {
    const invalid: unknown = { ...detail(a), author };
    vi.spyOn(testApi, 'getMessage').mockResolvedValue(invalid as MessageDetail);
    const { result } = renderHook(() => useCanonicalReply({ ...input, roots: [a] }), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.replies).toEqual([]);
  },
);

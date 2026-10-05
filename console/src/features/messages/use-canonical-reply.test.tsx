import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiProvider } from '../../api/context';
import { ApiError } from '../../api/client';
import { testApi } from '../../test/render';
import { afterEach, expect, it, vi } from 'vitest';
import { useCanonicalReply } from './use-canonical-reply';

function wrapper({ children }: { children: React.ReactNode }) {
  return <ApiProvider api={testApi}>{children}</ApiProvider>;
}

afterEach(() => { vi.useRealTimers(); });

it('usa el estado terminal del detalle exacto aunque el snapshot de la raíz siga accepted', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'stale-root', chain_open: false,
    deliveries: [{ delivery_id: 'stale-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: 'final durable' }],
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'stale-root', deliveryId: 'stale-delivery', status: 'accepted' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply).toMatchObject({ status: 'done', chainOpen: false, reply: 'final durable' });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(getMessage).toHaveBeenCalledOnce();
  unmount();
});

it('mantiene la recuperación de la final ausente cuando el detalle es done y el feed sigue accepted', async () => {
  vi.useFakeTimers();
  const detail = (reply: string | null) => ({
    message_id: 'stale-empty-root', chain_open: false,
    deliveries: [{ delivery_id: 'stale-empty-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done' as const, reply }],
  });
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce(detail(null)).mockResolvedValueOnce(detail(null)).mockResolvedValueOnce(detail(null))
    .mockResolvedValue(detail('final tardía'));
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'stale-empty-root', deliveryId: 'stale-empty-delivery', status: 'accepted' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(2);
  expect(getMessage).toHaveBeenCalledTimes(3);
  expect(result.current.reply?.reply).toBeNull();
  await advanceCanonicalReads(1);
  expect(result.current.reply).toMatchObject({ status: 'done', chainOpen: false, reply: 'final tardía' });
  expect(getMessage).toHaveBeenCalledTimes(4);
  await advanceCanonicalReads(8);
  expect(getMessage).toHaveBeenCalledTimes(4);
  unmount();
});

it('no convierte el detalle started en terminal por un hint done del feed', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce({ message_id: 'active-root', chain_open: true,
      deliveries: [{ delivery_id: 'active-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'started', reply: null }] })
    .mockResolvedValue({ message_id: 'active-root', chain_open: false,
      deliveries: [{ delivery_id: 'active-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: 'final' }] });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'active-root', deliveryId: 'active-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply).toMatchObject({ status: 'started', chainOpen: true, reply: null });
  await advanceCanonicalReads(1);
  expect(result.current.reply).toMatchObject({ status: 'done', chainOpen: false, reply: 'final' });
  await advanceCanonicalReads(4);
  expect(getMessage).toHaveBeenCalledTimes(2);
  unmount();
});

it('mantiene UNKNOWN cuando el detalle declara estado null aunque el feed diga done', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'unknown-root', chain_open: false,
    deliveries: [{ delivery_id: 'unknown-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: null, reply: 'sin terminal probado' }],
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'unknown-root', deliveryId: 'unknown-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply?.status).toBeNull();
  await advanceCanonicalReads(6);
  expect(getMessage).toHaveBeenCalledTimes(3);
  expect(result.current.reply?.status).toBeNull();
  unmount();
});

it.each([
  { message_id: 'other-root', delivery_id: 'bound-delivery', alias: 'agent-a' },
  { message_id: 'bound-root', delivery_id: 'other-delivery', alias: 'agent-a' },
  { message_id: 'bound-root', delivery_id: 'bound-delivery', alias: 'other-agent' },
])('rechaza un detalle terminal fuera de la raíz, entrega o alias esperado: %j', async (binding) => {
  vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: binding.message_id, chain_open: false,
    deliveries: [{ delivery_id: binding.delivery_id, tenant_id: 'tenant-a', alias: binding.alias, status: 'done', reply: 'no mezclar' }],
  });
  const { result } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'bound-root', deliveryId: 'bound-delivery', status: 'accepted' },
  }), { wrapper });
  await waitFor(() => { expect(result.current.error).toBeInstanceOf(Error); });
  expect(result.current.reply).toBeUndefined();
});

it('descarta la final de una lectura pendiente al cambiar humano, tenant, alias y raíz', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const getMessage = vi.spyOn(testApi, 'getMessage').mockImplementation(async (messageId) => {
    const second = messageId === 'generation-b';
    if (!second) await firstRead;
    return { message_id: messageId, chain_open: false, deliveries: [{
      delivery_id: second ? 'generation-delivery-b' : 'generation-delivery-a',
      tenant_id: second ? 'tenant-b' : 'tenant-a', alias: second ? 'agent-b' : 'agent-a',
      status: 'done', reply: second ? 'final de B' : 'final anterior de A',
    }] };
  });
  const visibleReplies: string[] = [];
  const { result, rerender } = renderHook(({ second }: { second: boolean }) => {
    const state = useCanonicalReply({
      publisherSubject: second ? 'operator-b' : 'operator-a',
      tenantId: second ? 'tenant-b' : 'tenant-a', alias: second ? 'agent-b' : 'agent-a',
      root: { messageId: second ? 'generation-b' : 'generation-a',
        deliveryId: second ? 'generation-delivery-b' : 'generation-delivery-a', status: 'accepted' },
    });
    if (typeof state.reply?.reply === 'string') visibleReplies.push(state.reply.reply);
    return state;
  }, { wrapper, initialProps: { second: false } });
  await waitFor(() => { expect(getMessage).toHaveBeenCalledWith('generation-a'); });
  rerender({ second: true });
  expect(result.current.reply).toBeUndefined();
  await act(async () => { releaseFirst?.(); });
  await waitFor(() => { expect(result.current.reply?.reply).toBe('final de B'); });
  expect(result.current.reply).toMatchObject({ tenantId: 'tenant-b', alias: 'agent-b', status: 'done' });
  expect(getMessage.mock.calls.map(([id]) => id)).toEqual(['generation-a', 'generation-b']);
  expect(visibleReplies).not.toContain('final anterior de A');
});

it('lee una sola raíz activa, valida delivery y mantiene explícito chain_open ausente', async () => {
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    id: 'root-1',
    deliveries: [{ delivery_id: 'delivery-1', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'respuesta' }],
  });
  const { result } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'root-1', deliveryId: 'delivery-1', status: 'done' },
  }), { wrapper });
  await waitFor(() => { expect(result.current.reply?.reply).toBe('respuesta'); });
  expect(result.current.reply?.chainOpen).toBeUndefined();
  expect(getMessage).toHaveBeenCalledOnce();
  expect(getMessage).toHaveBeenCalledWith('root-1');
});

it('purga el dato visible al perder autorización y permite relectura explícita', async () => {
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce({ message_id: 'root-2', deliveries: [{ delivery_id: 'delivery-2', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'dato previo' }], chain_open: true })
    .mockRejectedValueOnce(new ApiError('revoked', 403))
    .mockResolvedValueOnce({ message_id: 'root-2', deliveries: [{ delivery_id: 'delivery-2', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'permiso recuperado' }], chain_open: false });
  const { result } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'root-2', deliveryId: 'delivery-2', status: 'done' },
  }), { wrapper });
  await waitFor(() => { expect(result.current.reply?.reply).toBe('dato previo'); });
  await act(async () => { result.current.retry(); });
  await waitFor(() => { expect(result.current.accessDenied).toBe(true); });
  expect(result.current.reply).toBeUndefined();
  expect(getMessage).toHaveBeenCalledTimes(2);
  await act(async () => { result.current.retry(); });
  await waitFor(() => { expect(result.current.reply?.reply).toBe('permiso recuperado'); });
  expect(result.current.accessDenied).toBe(false);
  expect(getMessage).toHaveBeenCalledTimes(3);
});

it('rechaza un detalle cuya entrega pertenece a otro tenant/alias', async () => {
  vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'root-3',
    deliveries: [{ delivery_id: 'delivery-3', tenant_id: 'other-tenant', alias: 'agent-a', reply: 'no mezclar' }],
  });
  const { result } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'root-3', deliveryId: 'delivery-3', status: 'done' },
  }), { wrapper });
  await waitFor(() => { expect(result.current.error).toBeInstanceOf(Error); });
  expect(result.current.reply).toBeUndefined();
});

it('sigue leyendo una raíz HECHA mientras la cadena sigue abierta y detiene el polling al cerrar', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce({ message_id: 'root-4', deliveries: [{ delivery_id: 'delivery-4', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'provisional' }], chain_open: true })
    .mockResolvedValue({ message_id: 'root-4', deliveries: [{ delivery_id: 'delivery-4', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'final' }], chain_open: false });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'root-4', deliveryId: 'delivery-4', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply?.chainOpen).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
  expect(getMessage).toHaveBeenCalledTimes(2);
  expect(result.current.reply?.reply).toBe('final');
  await act(async () => { await vi.advanceTimersByTimeAsync(7_500); });
  expect(getMessage).toHaveBeenCalledTimes(2);
  unmount();
});

it('limita relecturas con cadena cerrada pero estado no terminal desconocido y deja el dato para revisión manual', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'root-5',
    deliveries: [{ delivery_id: 'delivery-5', tenant_id: 'tenant-a', alias: 'agent-a', reply: 'sin terminal' }],
    chain_open: false,
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'root-5', deliveryId: 'delivery-5' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  for (let read = 1; read < 3; read += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(getMessage).toHaveBeenCalledTimes(3);
  expect(result.current.reply?.reply).toBe('sin terminal');
  unmount();
});


async function advanceCanonicalReads(reads: number) {
  for (let read = 0; read < reads; read += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
  }
}

it.each([false, undefined])('recupera la final tardía de una raíz done con chain_open %s tras tres detalles sin respuesta', async (chainOpen) => {
  vi.useFakeTimers();
  const detail = (reply: string | null) => ({
    message_id: 'late-root', deliveries: [{ delivery_id: 'late-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done' as const, reply }],
    ...(chainOpen === undefined ? {} : { chain_open: chainOpen }),
  });
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce(detail(null)).mockResolvedValueOnce(detail(null)).mockResolvedValueOnce(detail(null))
    .mockResolvedValue(detail('final durable'));
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'late-root', deliveryId: 'late-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(2);
  expect(getMessage).toHaveBeenCalledTimes(3);
  expect(result.current.reply?.reply).toBeNull();
  await advanceCanonicalReads(1);
  expect(result.current.reply?.reply).toBe('final durable');
  expect(getMessage).toHaveBeenCalledTimes(4);
  await advanceCanonicalReads(8);
  expect(getMessage).toHaveBeenCalledTimes(4);
  unmount();
});

it('acota a dos minutos la relectura de una raíz done sin respuesta y no reinicia el plazo por cada detalle', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: 'empty-root', chain_open: false,
    deliveries: [{ delivery_id: 'empty-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: null }],
  });
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'empty-root', deliveryId: 'empty-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(48);
  expect(getMessage).toHaveBeenCalledTimes(49);
  expect(result.current.reply?.reply).toBeNull();
  await advanceCanonicalReads(20);
  expect(getMessage).toHaveBeenCalledTimes(49);
  unmount();
});

it.each([401, 403, 404])('purga y detiene la espera de respuesta tardía cuando el detalle devuelve %s', async (status) => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce({ message_id: 'denied-root', chain_open: false,
      deliveries: [{ delivery_id: 'denied-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: null }] })
    .mockRejectedValue(new ApiError('access denied', status));
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'denied-root', deliveryId: 'denied-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(1);
  expect(result.current.accessDenied).toBe(true);
  expect(result.current.reply).toBeUndefined();
  expect(getMessage).toHaveBeenCalledTimes(2);
  await advanceCanonicalReads(60);
  expect(getMessage).toHaveBeenCalledTimes(2);
  unmount();
});

it('conserva el límite de tres errores automáticos durante la espera de la final', async () => {
  vi.useFakeTimers();
  const getMessage = vi.spyOn(testApi, 'getMessage')
    .mockResolvedValueOnce({ message_id: 'error-root', chain_open: false,
      deliveries: [{ delivery_id: 'error-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done', reply: null }] })
    .mockRejectedValue(new ApiError('temporary', 503));
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'error-root', deliveryId: 'error-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(3);
  expect(getMessage).toHaveBeenCalledTimes(4);
  expect(result.current.stale).toBe(true);
  await advanceCanonicalReads(60);
  expect(getMessage).toHaveBeenCalledTimes(4);
  unmount();
});

it('renueva la ventana sólo al seleccionar otra identidad/raíz y no muestra el dato previo durante esa lectura', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  const startedAt = Date.now();
  const getMessage = vi.spyOn(testApi, 'getMessage').mockImplementation(async (messageId) => {
    const second = messageId === 'root-b';
    return { message_id: messageId, chain_open: false, deliveries: [{
      delivery_id: second ? 'delivery-b' : 'delivery-a', tenant_id: second ? 'tenant-b' : 'tenant-a',
      alias: second ? 'agent-b' : 'agent-a', status: 'done',
      reply: second && Date.now() - startedAt >= 122_500 ? 'final de B' : null,
    }] };
  });
  const { result, rerender, unmount } = renderHook(({ second }: { second: boolean }) => useCanonicalReply({
    publisherSubject: second ? 'operator-b' : 'operator-a', tenantId: second ? 'tenant-b' : 'tenant-a', alias: second ? 'agent-b' : 'agent-a',
    root: { messageId: second ? 'root-b' : 'root-a', deliveryId: second ? 'delivery-b' : 'delivery-a', status: 'done' },
  }), { wrapper, initialProps: { second: false } });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(46);
  expect(getMessage).toHaveBeenCalledTimes(47);
  rerender({ second: true });
  expect(result.current.reply).toBeUndefined();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.reply?.tenantId).toBe('tenant-b');
  expect(result.current.reply?.reply).toBeNull();
  await advanceCanonicalReads(3);
  expect(result.current.reply?.reply).toBe('final de B');
  expect(getMessage.mock.calls.slice(47).map(([id]) => id)).toEqual(['root-b', 'root-b', 'root-b', 'root-b']);
  await advanceCanonicalReads(6);
  expect(getMessage).toHaveBeenCalledTimes(51);
  unmount();
});


it('permite una nueva ventana mediante relectura manual y elimina el timer al cerrar la vista', async () => {
  vi.useFakeTimers();
  const detail = (reply: string | null) => ({ message_id: 'retry-root', chain_open: false,
    deliveries: [{ delivery_id: 'retry-delivery', tenant_id: 'tenant-a', alias: 'agent-a', status: 'done' as const, reply }] });
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue(detail(null));
  const { result, unmount } = renderHook(() => useCanonicalReply({
    publisherSubject: 'operator-a', tenantId: 'tenant-a', alias: 'agent-a',
    root: { messageId: 'retry-root', deliveryId: 'retry-delivery', status: 'done' },
  }), { wrapper });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await advanceCanonicalReads(48);
  expect(getMessage).toHaveBeenCalledTimes(49);
  getMessage.mockResolvedValueOnce(detail(null)).mockResolvedValue(detail('final tras relectura'));
  await act(async () => { result.current.retry(); });
  expect(getMessage).toHaveBeenCalledTimes(50);
  expect(result.current.reply?.reply).toBeNull();
  await advanceCanonicalReads(1);
  expect(getMessage).toHaveBeenCalledTimes(51);
  expect(result.current.reply?.reply).toBe('final tras relectura');
  unmount();
  await advanceCanonicalReads(60);
  expect(getMessage).toHaveBeenCalledTimes(51);
});

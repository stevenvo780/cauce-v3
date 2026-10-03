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

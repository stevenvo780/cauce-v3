import { expect, it, vi } from 'vitest';
import { readBoundedBlob } from './bounded-blob';

it('corta un cuerpo que supera el límite aunque no tenga Content-Length', async () => {
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); }, cancel: cancelled });
  await expect(readBoundedBlob(new Response(stream), 5)).rejects.toThrow('supera el límite'); expect(cancelled).toHaveBeenCalledOnce();
});

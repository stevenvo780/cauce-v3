export async function readBoundedBlob(response: Response, limit?: number): Promise<Blob> {
  if (limit === undefined) return response.blob();
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid download limit');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel(); throw new Error('El archivo supera el límite de descarga.');
  }
  if (!response.body) return new Blob([], { type: response.headers.get('content-type') ?? '' });
  const reader = response.body.getReader(); const parts: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('El archivo supera el límite de descarga.'); }
      parts.push(new Uint8Array(part.value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(parts, { type: response.headers.get('content-type') ?? '' });
}

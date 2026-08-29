import type { PtyEntry } from './pty-types';

export function writeOutput(entry: PtyEntry, data: ArrayBuffer | string): void {
  if (entry.outputFinished) return;
  if (entry.worker) {
    if (typeof data === 'string') entry.worker.postMessage({ type: 'chunk', data });
    else entry.worker.postMessage({ type: 'chunk', data }, [data]);
    return;
  }
  // No Worker available (headless test runtime): decode inline, same streaming semantics.
  entry.decoder ??= new TextDecoder();
  entry.terminal.write(typeof data === 'string' ? data : entry.decoder.decode(data, { stream: true }));
}

/** Finalizes the incremental state: a last incomplete code point does not vanish silently. */
export function finishOutput(entry: PtyEntry): void {
  if (entry.outputFinished) return;
  entry.outputFinished = true;
  if (entry.worker) {
    entry.worker.postMessage({ type: 'close' });
    return;
  }
  const tail = entry.decoder?.decode() ?? '';
  if (tail) entry.terminal.write(tail);
}

export function initTerminalWorker(entry: PtyEntry): void {
  if (typeof Worker !== 'function') return;
  const worker = new Worker(new URL('./terminal.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ type: 'flush'; data: string } | { type: 'closed' }>) => {
    if (event.data.type === 'closed') {
      worker.terminate();
      if (entry.worker === worker) entry.worker = undefined;
      return;
    }
    if (!entry.closed) entry.terminal.write(event.data.data);
  };
  entry.worker = worker;
}

type Inbound = { type: 'chunk'; data: string | ArrayBuffer } | { type: 'close' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const decoder = new TextDecoder();
let chunks: string[] = [];
let timer: number | undefined;

function flush(): void {
  timer = undefined;
  if (chunks.length === 0) return;
  scope.postMessage({ type: 'flush', data: chunks.join('') });
  chunks = [];
}

scope.onmessage = (event: MessageEvent<Inbound>) => {
  if (event.data.type === 'close') {
    if (timer !== undefined) clearTimeout(timer);
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    flush();
    scope.postMessage({ type: 'closed' });
    scope.close();
    return;
  }
  chunks.push(typeof event.data.data === 'string' ? event.data.data : decoder.decode(event.data.data, { stream: true }));
  if (chunks.reduce((size, chunk) => size + chunk.length, 0) >= 8192) flush();
  else if (timer === undefined) timer = scope.setTimeout(flush, 16);
};

export {};

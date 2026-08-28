import {
  MAX_INPUT_FRAME_BYTES,
  MAX_PENDING_INPUT_BYTES,
  PTY_CLOSE_MESSAGES,
  UTF8_ENCODER,
  esRespuestaTecnicaDelTerminal,
  type PtyEntry,
} from './pty-types';

/** Drops a pending keystroke batch: once the channel is gone there is nowhere to send it. */
export function cancelPendingInput(entry: PtyEntry): void {
  if (entry.inputTimer !== undefined) window.clearTimeout(entry.inputTimer);
  entry.inputTimer = undefined;
  entry.inputChunks = [];
  entry.inputBytes = 0;
}

/** The input buffer coalesces keystrokes over 8 ms so a burst is one frame, not one frame per key. */
export function queueInput(
  entry: PtyEntry,
  data: string,
  onFlood: (message: string, code: number) => void,
): void {
  if (entry.readOnly) {
    if (!esRespuestaTecnicaDelTerminal(data) || entry.socket?.readyState !== WebSocket.OPEN) return;
    entry.socket.send(JSON.stringify({ type: 'terminal_response', data }));
    return;
  }
  const bytes = UTF8_ENCODER.encode(data).byteLength;
  if (bytes > MAX_INPUT_FRAME_BYTES || entry.inputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    cancelPendingInput(entry);
    onFlood(PTY_CLOSE_MESSAGES[4414], 4414);
    if (entry.socket?.readyState === WebSocket.OPEN) entry.socket.close(4414, 'input_flood');
    return;
  }
  entry.inputChunks.push(data);
  entry.inputBytes += bytes;
  if (entry.inputTimer !== undefined) return;
  entry.inputTimer = window.setTimeout(() => {
    entry.inputTimer = undefined;
    const chunks = entry.inputChunks;
    entry.inputChunks = [];
    entry.inputBytes = 0;
    if (chunks.length === 0 || entry.socket?.readyState !== WebSocket.OPEN) return;

    let batch: string[] = [];
    let batchBytes = 0;
    const flushBatch = (): void => {
      if (batch.length === 0 || entry.socket?.readyState !== WebSocket.OPEN) return;
      entry.socket.send(JSON.stringify({ type: 'input', data: batch.join('') }));
      batch = [];
      batchBytes = 0;
    };
    for (const chunk of chunks) {
      const chunkBytes = UTF8_ENCODER.encode(chunk).byteLength;
      if (batchBytes + chunkBytes > MAX_INPUT_FRAME_BYTES) flushBatch();
      batch.push(chunk);
      batchBytes += chunkBytes;
    }
    flushBatch();
  }, 8);
}

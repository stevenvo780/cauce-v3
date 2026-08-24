/**
 * Wire framing of the agent leg: `[tag:1][length:4 big-endian][payload]`.
 *
 * The same bytes are produced by the Python PTY agent, so the encoders here are the
 * TypeScript half of a cross-language contract: no field order, padding or encoding may
 * change without changing the agent and the interop golden vectors together.
 */

export const FRAME_TAGS = {
  AGENT_HELLO: 0x01,
  HELLO_ACK: 0x02,
  OPEN: 0x10,
  OPEN_OK: 0x11,
  OPEN_ERR: 0x12,
  STDIN: 0x20,
  STDOUT: 0x21,
  RESIZE: 0x22,
  CLOSE: 0x30,
  CLOSED: 0x31,
  PING: 0x40,
  PONG: 0x41,
  // Lectura de ficheros de gobierno. Es una transacción suelta, no una sesión, así que no reusa
  // OPEN. Añadirlos aquí es lo que impide que la respuesta del agente sea un `unknown frame tag`:
  // el decodificador trata un tag desconocido como violación y tira la conexión ENTERA, con
  // todas las terminales abiertas encima.
  READ: 0x50,
  READ_OK: 0x51,
  READ_ERR: 0x52,
  READ_DATA: 0x53
} as const;

export type FrameTag = (typeof FRAME_TAGS)[keyof typeof FRAME_TAGS];

/** A frame payload never exceeds this; a longer declared length is a protocol violation. */
export const MAX_FRAME_PAYLOAD_BYTES = 65_536;
/**
 * DATA payloads carry the session UUID (with dashes) as 36 leading ASCII bytes. READ_DATA uses
 * the same prefix for the `request_id` of the read on purpose: el agente lo genera con el mismo
 * formato para que `decodeDataFrame` valga para los dos y no haya una segunda ruta de código.
 */
export const SESSION_ID_BYTES = 36;
export const MAX_DATA_BYTES = MAX_FRAME_PAYLOAD_BYTES - SESSION_ID_BYTES;

const FRAME_HEADER_BYTES = 5;
const KNOWN_TAGS = new Set<number>(Object.values(FRAME_TAGS));
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY = Buffer.alloc(0);

/** Any framing violation is terminal for the connection: the peer is not speaking our protocol. */
export class FramingError extends Error {}

export interface Frame {
  readonly tag: FrameTag;
  readonly payload: Buffer;
}

export function isFrameTag(value: number): value is FrameTag {
  return KNOWN_TAGS.has(value);
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function encodeFrame(tag: FrameTag, payload: Uint8Array = EMPTY): Buffer {
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) throw new FramingError('frame payload exceeds the wire limit');
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt8(tag, 0);
  frame.writeUInt32BE(payload.byteLength, 1);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(tag: FrameTag, value: Record<string, unknown>): Buffer {
  return encodeFrame(tag, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function encodeDataFrame(tag: FrameTag, sessionId: string, data: Uint8Array): Buffer {
  if (!isSessionId(sessionId)) throw new FramingError('data frames require a lowercase dashed session UUID');
  if (data.byteLength > MAX_DATA_BYTES) throw new FramingError('data payload exceeds the wire limit');
  const payload = Buffer.allocUnsafe(SESSION_ID_BYTES + data.byteLength);
  payload.write(sessionId, 0, SESSION_ID_BYTES, 'ascii');
  payload.set(data, SESSION_ID_BYTES);
  return encodeFrame(tag, payload);
}

export interface DataFrame {
  readonly sessionId: string;
  readonly data: Buffer;
}

export function decodeDataFrame(payload: Buffer): DataFrame {
  if (payload.byteLength < SESSION_ID_BYTES) throw new FramingError('data frame is shorter than a session id');
  const sessionId = payload.subarray(0, SESSION_ID_BYTES).toString('ascii');
  if (!isSessionId(sessionId)) throw new FramingError('data frame carries an invalid session id');
  return { sessionId, data: payload.subarray(SESSION_ID_BYTES) };
}

/** JSON frames always carry an object; arrays and scalars are rejected before any field read. */
export function decodeJsonFrame(payload: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new FramingError('frame payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FramingError('frame payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Incremental decoder: TCP hands us arbitrary fragmentation, so every call may complete zero,
 * one or many frames and may leave a partial header behind.
 */
export class FrameDecoder {
  private pending: Buffer = EMPTY;

  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    let offset = 0;
    for (;;) {
      if (this.pending.byteLength - offset < FRAME_HEADER_BYTES) break;
      const tag = this.pending.readUInt8(offset);
      const length = this.pending.readUInt32BE(offset + 1);
      if (length > MAX_FRAME_PAYLOAD_BYTES) throw new FramingError('frame length exceeds the wire limit');
      if (!isFrameTag(tag)) throw new FramingError('unknown frame tag');
      const end = offset + FRAME_HEADER_BYTES + length;
      if (this.pending.byteLength < end) break;
      frames.push({ tag, payload: Buffer.from(this.pending.subarray(offset + FRAME_HEADER_BYTES, end)) });
      offset = end;
    }
    this.pending = offset === this.pending.byteLength ? EMPTY : Buffer.from(this.pending.subarray(offset));
    return frames;
  }
}

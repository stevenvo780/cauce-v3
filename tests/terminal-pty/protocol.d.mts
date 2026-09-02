// Types for the reference wire implementation in ./protocol.mjs.
// Kept next to the module so the vitest suites can import it under NodeNext resolution.

export declare const WIRE_VERSION: 1;
export declare const MAX_FRAME_PAYLOAD: 65536;
export declare const SESSION_ID_BYTES: 36;
export declare const FRAME_HEADER_BYTES: 5;
export declare const TICKET_HKDF_SALT: string;
export declare const TICKET_PREFIX: string;

export declare const TAG: {
  AGENT_HELLO: number; HELLO_ACK: number; OPEN: number; OPEN_OK: number; OPEN_ERR: number;
  STDIN: number; STDOUT: number; RESIZE: number; TERMINAL_RESPONSE: number;
  PAUSE_OUTPUT: number; RESUME_OUTPUT: number; CLOSE: number; CLOSED: number;
  PING: number; PONG: number;
  READ: number; READ_OK: number; READ_ERR: number; READ_DATA: number; READ_DONE: number;
  WRITE: number; WRITE_DATA: number; WRITE_OK: number; WRITE_ERR: number; WRITE_CANCEL: number;
  WRITE_BATCH: number; WRITE_BATCH_DATA: number; WRITE_BATCH_OK: number;
  WRITE_BATCH_ERR: number; WRITE_BATCH_CANCEL: number;
};
export declare const TAG_NAME: Record<number, string>;
export declare const DATA_TAGS: Set<number>;
/**
 * Tags whose payload opens with the 36 ASCII bytes of an identifier: a session id for
 * STDIN/STDOUT/TERMINAL_RESPONSE, a governance request id for
 * READ_DATA/WRITE_DATA/WRITE_BATCH_DATA. The agent keeps one decoder for all of them
 * (PREFIXED_TAGS in ops/pty-agent/cauce_pty_agent/framing.py).
 */
export declare const PREFIXED_TAGS: Set<number>;
export declare const EMPTY_TAGS: Set<number>;
export declare const JSON_TAGS: Set<number>;
export declare const CLOSE_CODE: Record<string, number>;
export declare const TICKET_PAYLOAD_KEYS: readonly string[];
export declare const TICKET_TARGET_KEYS: readonly string[];

export interface TicketTarget {
  tenant: string; alias: string; container: string; generation: string;
  image: string; uid: number; user: string;
}

export interface TicketPayload {
  v: number; sid: string; op: string; sub: string; tgt: TicketTarget;
  mode: string; iat: number; exp: number;
}

export interface TicketVerifyOptions {
  now?: number;
  clock_skew_sec?: number;
  session_id?: string;
  tenant?: string;
  alias?: string;
  container_id?: string;
  generation?: string;
  modes?: readonly string[];
}

export type TicketVerifyResult =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: string; payload?: TicketPayload };

export declare class FrameError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export declare class TicketError extends Error {
  constructor(reason: string, message?: string);
  readonly reason: string;
}

export interface TicketOverrides {
  sid?: string;
  op?: string;
  sub?: string;
  mode?: string;
  tenant?: string;
  alias?: string;
  container?: string;
  generation?: string;
  image?: string;
  uid?: number;
  user?: string;
  iat?: number;
  exp?: number;
}

export declare function b64urlEncode(bytes: Uint8Array | Buffer): string;
export declare function b64urlDecode(text: string): Buffer;
export declare function deriveAliasKey(master: Buffer | string, tenant: string, alias: string): Buffer;
export declare function canonicalTicketPayload(payload: Partial<TicketPayload>): string;
export declare function mintTicket(aliasKey: Buffer, payload: Partial<TicketPayload>): string;
export declare function ticketPayload(overrides?: TicketOverrides): TicketPayload;
export declare function verifyTicket(aliasKey: Buffer, ticket: unknown, options?: TicketVerifyOptions): TicketVerifyResult;
export declare function closeCodeForTicketReason(reason: string): number;
export declare function encodeFrame(tag: number, payload?: Buffer | Uint8Array): Buffer;
export declare function encodeJsonFrame(tag: number, value: unknown): Buffer;
export declare function encodeDataFrame(tag: number, sessionId: string, data: Buffer | string): Buffer;
export declare function decodeJsonPayload(payload: Buffer): Record<string, unknown>;
export declare function decodeDataPayload(payload: Buffer): { session_id: string; data: Buffer };
export declare function assertSessionId(sessionId: string): string;
export declare function isKnownTag(tag: number): boolean;

export interface DecodedFrame {
  tag: number;
  payload: Buffer;
  known: boolean;
}

export declare class FrameDecoder {
  constructor(options?: { max_payload?: number });
  readonly pending: number;
  push(chunk: Buffer | Uint8Array): DecodedFrame[];
}

export declare function decodeSingleFrame(bytes: Buffer | Uint8Array): DecodedFrame;

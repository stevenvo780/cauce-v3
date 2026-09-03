import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Append-only asciicast v2 recording of one terminal session. It is the ONLY place a byte the
 * operator typed is ever stored: the close report and every audit row carry counts and this
 * file's digest, never its content. A writable session without a recording is not a mode, so
 * `open` throwing is a refusal to open the terminal, not a degraded mode.
 */

export const DEFAULT_RECORDING_MAX_BYTES = 32 * 1024 * 1024;
const RECORDING_CAP_MARKER = 'cauce:recording_capped';

export class RecordingUnavailableError extends Error {}

export interface RecordingCloseReport {
  readonly sha256: string;
  readonly bytes: number;
  readonly input_batches: number;
  readonly capped: boolean;
}

export interface SessionRecordingOptions {
  readonly directory: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly now?: () => number;
}

type EventKind = 'o' | 'i' | 'm';

function positiveCap(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_RECORDING_MAX_BYTES;
  }
  return value;
}

export class SessionRecording {
  private readonly descriptor: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly digest: Hash = createHash('sha256');
  private readonly decoders: Record<'o' | 'i', StringDecoder> = {
    o: new StringDecoder('utf8'),
    i: new StringDecoder('utf8'),
  };
  private written = 0;
  private inputBatches = 0;
  private capped = false;
  private isBroken = false;
  private isClosed = false;

  private constructor(descriptor: number, options: SessionRecordingOptions) {
    this.descriptor = descriptor;
    this.maxBytes = positiveCap(options.maxBytes);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.append(`${JSON.stringify({
      version: 2,
      width: options.cols,
      height: options.rows,
      timestamp: Math.floor(this.startedAt / 1_000),
    })}\n`);
  }

  /**
   * `O_EXCL` is the point: two relays or a replayed session id must never append into the same
   * file, because a recording that two writers interleave attests to nothing.
   */
  static open(sessionId: string, options: SessionRecordingOptions): SessionRecording {
    const directory = options.directory;
    if (directory === undefined || directory.length === 0) {
      throw new RecordingUnavailableError('terminal recording directory is not configured');
    }
    let descriptor: number;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = openSync(
        join(directory, `${sessionId}.cast`),
        constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch {
      throw new RecordingUnavailableError('terminal recording file could not be created');
    }
    return new SessionRecording(descriptor, options);
  }

  /** True once a write failed: the caller closes the session rather than keep typing unrecorded. */
  get broken(): boolean {
    return this.isBroken;
  }

  recordOutput(data: Buffer): void {
    this.event('o', data);
  }

  recordInput(data: Buffer): void {
    if (this.isClosed || this.capped || this.isBroken) return;
    this.inputBatches += 1;
    this.event('i', data);
  }

  close(): RecordingCloseReport {
    if (!this.isClosed) {
      this.isClosed = true;
      try {
        closeSync(this.descriptor);
      } catch {
        this.isBroken = true;
      }
    }
    return {
      sha256: this.digest.copy().digest('hex'),
      bytes: this.written,
      input_batches: this.inputBatches,
      capped: this.capped,
    };
  }

  private event(kind: 'o' | 'i', data: Buffer): void {
    if (this.isClosed || this.capped || this.isBroken || data.byteLength === 0) return;
    const text = this.decoders[kind].write(data);
    if (text.length === 0) return;
    const line = this.line(kind, text);
    if (this.written + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
      this.capped = true;
      this.append(this.line('m', RECORDING_CAP_MARKER));
      return;
    }
    this.append(line);
  }

  private line(kind: EventKind, text: string): string {
    return `${JSON.stringify([(this.now() - this.startedAt) / 1_000, kind, text])}\n`;
  }

  private append(line: string): void {
    const payload = Buffer.from(line, 'utf8');
    try {
      let offset = 0;
      while (offset < payload.byteLength) {
        offset += writeSync(this.descriptor, payload, offset, payload.byteLength - offset);
      }
    } catch {
      this.isBroken = true;
      return;
    }
    this.digest.update(payload);
    this.written += payload.byteLength;
  }
}

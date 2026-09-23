import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorLabel, logEvent } from '@cauce/protocol';

/**
 * One line per decision. The state never enters: only its SHA-256 and its length, so a decision
 * can be correlated with what the caller holds without the log becoming a copy of it.
 */
export interface AuditRecord {
  readonly ts: string;
  readonly id: string;
  readonly tenant: string;
  readonly alias: string;
  readonly plantilla: string | null;
  readonly version_plantilla: string | null;
  readonly version_catalogo: string;
  readonly preguntas: readonly { readonly id: string; readonly tipo: string }[];
  readonly state_sha256: string;
  readonly state_bytes: number;
  readonly redacciones: number;
  readonly origen: 'jev' | 'prefiltro' | 'fallo' | 'rechazo';
  readonly estado: string;
  readonly ms: number;
  readonly solicitudes_jev: number;
  /** What this decision took from the daily caps: usage (or the estimate) times the billable requests. */
  readonly tokens_cobrados: number;
  readonly modelo: string | null;
  readonly jev_request_id: string | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number } | null;
  readonly certeza: Readonly<Record<string, number>>;
  readonly certeza_min: number | null;
  readonly decision: string | null;
  readonly caer_a_llm: boolean;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export function stateDigest(serialized: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

/** Appends JSONL with mode 0600 and rotates to `<file>.1` once it passes `maxBytes`. */
export class JsonlAudit implements AuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly maxBytes: number) {}

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.file)).size >= this.maxBytes) await rename(this.file, `${this.file}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Serialised so rotation and append never interleave; a failed write is logged, never fatal. */
  write(record: AuditRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.tail = this.tail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await this.rotateIfNeeded();
      await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
    }).catch((error: unknown) => {
      logEvent('decisiones_auditoria_fallida', { error: errorLabel(error) }, { level: 'error' });
    });
    return this.tail;
  }
}

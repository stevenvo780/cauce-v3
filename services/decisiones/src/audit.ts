import { createHash } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';

/**
 * One line per decision. The state never enters: only its SHA-256 and its length, so a decision
 * can be correlated with what the caller holds without the log becoming a copy of it.
 */
export interface AuditRecord {
  readonly ts: string;
  readonly id: string;
  readonly company: string;
  readonly tenant: string;
  readonly alias: string;
  readonly host?: string;
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
  /** The decision's own certainty: that of the answers the deciding rule rested on. */
  readonly confianza: number | null;
  readonly decision: string | null;
  readonly caer_a_llm: boolean;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export class PostgresAudit implements AuditSink {
  constructor(private readonly pool: Pick<DatabasePool, 'query'>) {}

  async write(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,company_id,action,decision,metadata)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [record.tenant, record.alias, record.company,
        record.estado === 'ok' ? 'decision.resolved' : 'decision.failed',
        record.estado === 'ok' ? 'info' : 'deny', JSON.stringify({
          operation_id: record.id, operation: record.plantilla ?? 'free',
          ...(record.host === undefined ? {} : { host_id: record.host }),
          ts: record.ts, preguntas: record.preguntas, redacciones: record.redacciones,
          template_version: record.version_plantilla, catalog_version: record.version_catalogo,
          state_sha256: record.state_sha256, state_bytes: record.state_bytes,
          outcome: record.decision, origin: record.origen, status: record.estado,
          model: record.modelo, jev_request_id: record.jev_request_id, ms: record.ms,
          solicitudes_jev: record.solicitudes_jev, usage: record.usage,
          certeza: record.certeza, certeza_min: record.certeza_min, confianza: record.confianza,
          caer_a_llm: record.caer_a_llm, tokens_charged: record.tokens_cobrados,
        })],
    );
  }
}

export function stateDigest(serialized: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

import {
  AliasSchema, PREFIJO_REVISION_PERFIL, TenantSchema, VERSION_REVISION_PERFIL,
  bloqueDePerfil, sinBloqueDePerfil,
} from '@cauce/protocol';

/** Context contamination guard: decides, from measured facts and the recorded expectation, whether
 * the governance files of an alias hold something that is not its own. The verdict names the OWNING
 * alias of an intruding block and never a byte of what the block says. */

export const CONTEXT_CONTAMINATION_REASONS = [
  'foreign_managed_block', 'expectation_sha_mismatch',
] as const;

export type ContextContaminationReason = typeof CONTEXT_CONTAMINATION_REASONS[number];

export interface MeasuredContextDocument {
  readonly name: string;
  readonly path: string;
  /** `null` when the file is absent. */
  readonly sha: string | null;
  /** Whole text, or `null` when it was not read whole. A prefix can never prove ownership. */
  readonly text: string | null;
  /** What the reload is about to write there; only the block it holds is evidence of anything. */
  readonly intended?: string | null;
}

export interface MeasuredContext {
  readonly owner: { readonly tenant_id: string; readonly alias: string };
  /** Runtime generation of the measured presence; `null` when it publishes none. */
  readonly generation: string | null;
  readonly documents: readonly MeasuredContextDocument[];
}

export interface RecordedContextExpectation {
  readonly generation: string;
  readonly documents: readonly {
    readonly name: string; readonly path: string; readonly sha: string;
  }[];
}

export interface ContextContaminationFinding {
  readonly reason: ContextContaminationReason;
  readonly document: string;
  readonly path: string;
  /** Tenant-qualified alias that owns the intruding block. */
  readonly owner?: string;
  readonly expected_sha?: string;
  readonly observed_sha?: string | null;
}

export interface ContextContaminationVerdict {
  readonly contaminated: boolean;
  readonly findings: readonly ContextContaminationFinding[];
}

const RENGLON_DE_DUENO = /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/u;

const RENGLON_DE_REVISION = new RegExp(
  `^${PREFIJO_REVISION_PERFIL} v${VERSION_REVISION_PERFIL} revision=[1-9][0-9]* -->$`, 'u',
);

interface DuenoDelBloque {
  readonly dueno?: string;
}

function duenoDelBloque(bloque: string): DuenoDelBloque | undefined {
  const crudo = RENGLON_DE_DUENO.exec(bloque)?.[1];
  if (crudo === undefined) return undefined;
  const partes = crudo.split('/');
  const legible = partes.length === 2
    && TenantSchema.safeParse(partes[0]).success && AliasSchema.safeParse(partes[1]).success;
  return legible ? { dueno: crudo } : {};
}

function bloqueAjeno(
  documento: MeasuredContextDocument, dueno: string,
): ContextContaminationFinding | undefined {
  if (documento.text === null) return undefined;
  const bloque = bloqueDePerfil(documento.text);
  if (bloque === undefined) return undefined;
  const suyo = duenoDelBloque(bloque);
  if (suyo === undefined || suyo.dueno === dueno) return undefined;
  return {
    reason: 'foreign_managed_block',
    document: documento.name,
    path: documento.path,
    ...(suyo.dueno === undefined ? {} : { owner: suyo.dueno }),
  };
}

/** The one drift that is not contamination: the adapter re-renders its OWN block at every hello, so
 * the digest stops matching an expectation nobody violated. It holds only while nothing but Cauce's
 * own revision marker sits outside that block — the projection copies whatever is outside verbatim
 * from disk, so it can never witness prose added there, and accepting such a file would re-record
 * the expectation over it and make the injection invisible from then on. */
function soloCambioSuBloque(documento: MeasuredContextDocument): boolean {
  if (typeof documento.text !== 'string' || typeof documento.intended !== 'string') return false;
  if (bloqueDePerfil(documento.text) === undefined) return false;
  const exterior = sinBloqueDePerfil(documento.text);
  if (exterior !== sinBloqueDePerfil(documento.intended)) return false;
  return exterior.split('\n').every(
    (renglon) => renglon.length === 0 || RENGLON_DE_REVISION.test(renglon),
  );
}

function huellaDistinta(
  documento: MeasuredContextDocument,
  esperado: RecordedContextExpectation,
): ContextContaminationFinding | undefined {
  const contrato = esperado.documents.find((entry) => entry.name === documento.name);
  if (contrato?.path !== documento.path || contrato.sha === documento.sha) return undefined;
  if (soloCambioSuBloque(documento)) return undefined;
  return {
    reason: 'expectation_sha_mismatch',
    document: documento.name,
    path: documento.path,
    expected_sha: contrato.sha,
    observed_sha: documento.sha,
  };
}

/**
 * Only against an expectation of the generation ALIVE right now: an older one mismatching is
 * ordinary drift, what a reload fixes, and quarantining that would strand the alias forever.
 */
export function evaluarContaminacion(
  medido: MeasuredContext,
  esperado: RecordedContextExpectation | undefined,
): ContextContaminationVerdict {
  const dueno = `${medido.owner.tenant_id}/${medido.owner.alias}`;
  const vigente = esperado !== undefined && medido.generation !== null
    && esperado.generation === medido.generation
    ? esperado
    : undefined;
  const findings: ContextContaminationFinding[] = [];
  for (const documento of medido.documents) {
    const ajeno = bloqueAjeno(documento, dueno);
    if (ajeno !== undefined) findings.push(ajeno);
    if (vigente === undefined) continue;
    const distinta = huellaDistinta(documento, vigente);
    if (distinta !== undefined) findings.push(distinta);
  }
  return { contaminated: findings.length > 0, findings };
}

/** Process-local counter with a fixed label vocabulary: only how many times each reason
 * quarantined a write or a reload, never the tenant, alias, path or digest behind it. */
export class ContextContaminationTelemetry {
  private readonly counters = new Map<ContextContaminationReason, number>(
    CONTEXT_CONTAMINATION_REASONS.map((reason) => [reason, 0]),
  );

  record(reason: ContextContaminationReason): void {
    const current = this.counters.get(reason);
    if (current === undefined) throw new Error('unknown context contamination reason');
    this.counters.set(reason, current + 1);
  }

  recordVerdict(verdict: ContextContaminationVerdict): void {
    for (const finding of verdict.findings) this.record(finding.reason);
  }

  snapshot(): Readonly<Record<ContextContaminationReason, number>> {
    return Object.fromEntries(this.counters) as Record<ContextContaminationReason, number>;
  }
}

/** One counter per process, shared by the routes that quarantine and by `/metrics`. Wiring it
 * through the gateway options would put the scrape and the increment in two objects that only
 * agree while somebody remembers to pass the same one. */
export const contextContamination = new ContextContaminationTelemetry();

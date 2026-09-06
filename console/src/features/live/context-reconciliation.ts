import { esRecargaHecha, type RespuestaDeRecarga } from './perfil';

export interface ReconciliationDocument {
  readonly name: string;
  readonly observed_sha: string;
  readonly exterior_sha: string;
}

export interface ReconciliationPreview {
  readonly ok: true;
  readonly tenant_id: string;
  readonly alias: string;
  readonly expected_revision: number;
  readonly expected_runtime_generation: string;
  readonly preserve_external: true;
  readonly documents: readonly ReconciliationDocument[];
}

export interface ReconciliationApply {
  readonly reason: string;
  readonly expected_revision: number;
  readonly expected_runtime_generation: string;
  readonly preserve_external: true;
  readonly documents: readonly ReconciliationDocument[];
}

const SHA = /^[0-9a-f]{64}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isReconciliationPreview(
  value: unknown, expected: { tenantId: string; alias: string; revision: number; documents: readonly string[] },
): value is ReconciliationPreview {
  const row = record(value);
  if (row?.ok !== true || row.tenant_id !== expected.tenantId || row.alias !== expected.alias
    || !Number.isSafeInteger(row.expected_revision) || Number(row.expected_revision) < 1
    || row.expected_revision !== expected.revision || row.preserve_external !== true
    || typeof row.expected_runtime_generation !== 'string'
    || row.expected_runtime_generation.trim().length === 0 || row.expected_runtime_generation.length > 128
    || !Array.isArray(row.documents) || row.documents.length === 0
    || row.documents.length !== expected.documents.length
    || new Set(expected.documents).size !== expected.documents.length) return false;
  const names = new Set<string>();
  return row.documents.every((value: unknown) => {
    const document = record(value);
    if (typeof document?.name !== 'string' || !expected.documents.includes(document.name)
      || names.has(document.name) || typeof document.observed_sha !== 'string'
      || !SHA.test(document.observed_sha) || typeof document.exterior_sha !== 'string'
      || !SHA.test(document.exterior_sha)) return false;
    names.add(document.name);
    return true;
  });
}

export function reconciliationApply(preview: ReconciliationPreview, reason: string): ReconciliationApply {
  return {
    reason: reason.trim(), expected_revision: preview.expected_revision,
    expected_runtime_generation: preview.expected_runtime_generation, preserve_external: true,
    documents: preview.documents.map(({ name, observed_sha, exterior_sha }) => ({ name, observed_sha, exterior_sha })),
  };
}

export function isReconciliationReceipt(
  value: unknown, preview: ReconciliationPreview,
): value is RespuestaDeRecarga {
  if (!esRecargaHecha(value, { tenantId: preview.tenant_id, alias: preview.alias })
    || record(value)?.preserve_external !== true || value.state !== 'pending_session_refresh'
    || value.evidence !== 'runtime_verification' || value.revision !== preview.expected_revision
    || value.contaminacion.contaminated || value.contaminacion.findings.length !== 0
    || value.runtime_verification.state !== 'current'
    || value.runtime_verification.generation !== preview.expected_runtime_generation
    || value.documents.length !== preview.documents.length
    || value.runtime_verification.documents.length !== preview.documents.length) return false;
  const receipts = new Map(value.documents.map((document) => [document.name, document]));
  const measured = value.runtime_verification.documents.map((document: unknown) => record(document));
  if (receipts.size !== preview.documents.length
    || new Set(measured.map((document) => document?.name)).size !== preview.documents.length) return false;
  return preview.documents.every((before) => {
    const after = receipts.get(before.name);
    const evidence = measured.find((document) => document?.name === before.name);
    return after?.sha_before === before.observed_sha
      && after.path.split('/').at(-1) === before.name
      && !after.path.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')
      && !after.path.includes('\0') && evidence?.current === true
      && evidence.path === after.path && evidence.expected_sha === after.sha_after
      && evidence.observed_sha === after.sha_after && evidence.expected_bytes === after.bytes
      && evidence.observed_bytes === after.bytes;
  });
}

import { AliasSchema, TenantSchema } from '@cauce/protocol';

interface ContextWriteSelection {
  readonly name: string;
  readonly path: string;
}
interface OperatorAttribution {
  readonly operatorId: string;
  readonly attributed: boolean;
  readonly reason: string;
}
export type ContextWriteAuditAttribution = OperatorAttribution & (
  | { readonly kind: 'operator' }
  | { readonly kind: 'principal'; readonly principal: string }
);
interface ContextWritePlanBase<Attribution extends ContextWriteAuditAttribution> {
  readonly actor: { readonly tenantId: string; readonly alias: string };
  readonly audit: { readonly traceId: string; readonly attribution: Attribution };
  readonly journalDocuments: readonly (ContextWriteSelection & { readonly kind: string })[];
}
export type ContextWritePlan = (ContextWritePlanBase<OperatorAttribution & { readonly kind: 'operator' }> & (
  | { readonly operation: 'document' }
  | { readonly operation: 'profile'; readonly expectationDocuments: readonly ContextWriteSelection[];
      readonly sourceReceipt: { readonly applicationId: string; readonly revision: number } | null }
  | { readonly operation: 'reconcile'; readonly expectationDocuments: readonly ContextWriteSelection[] }
)) | (ContextWritePlanBase<OperatorAttribution & { readonly kind: 'principal'; readonly principal: string }>
  & { readonly operation: 'reload'; readonly expectationDocuments: readonly ContextWriteSelection[] });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024
    && Buffer.from(value).every((byte) => byte >= 32);
}
function selections(value: unknown, journal: boolean): boolean {
  if (!Array.isArray(value) || value.length > 7 || (!journal && value.length === 0)) return false;
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const item of value) {
    if (!record(item) || !keys(item, journal ? ['name', 'path', 'kind'] : ['name', 'path'])
      || !text(item.name) || !text(item.path) || !item.path.startsWith('/')
      || (journal && !text(item.kind)) || names.has(item.name) || paths.has(item.path)) return false;
    names.add(item.name); paths.add(item.path);
  }
  return true;
}
function attribution(value: unknown): value is ContextWriteAuditAttribution {
  return record(value) && (value.kind === 'operator' || value.kind === 'principal')
    && keys(value, ['kind', 'operatorId', 'attributed', 'reason', ...(value.kind === 'principal' ? ['principal'] : [])])
    && text(value.operatorId) && text(value.reason) && typeof value.attributed === 'boolean'
    && (value.kind !== 'principal' || text(value.principal));
}
export function parseContextWritePlan(value: unknown): ContextWritePlan | undefined {
  if (!record(value)) return undefined;
  const extra = value.operation === 'document' ? []
    : value.operation === 'profile' ? ['expectationDocuments', 'sourceReceipt']
      : ['expectationDocuments'];
  if (!['document', 'profile', 'reload', 'reconcile'].includes(String(value.operation))
    || !keys(value, ['operation', 'actor', 'audit', 'journalDocuments', ...extra])
    || !record(value.actor) || !keys(value.actor, ['tenantId', 'alias'])
    || !TenantSchema.safeParse(value.actor.tenantId).success || !AliasSchema.safeParse(value.actor.alias).success
    || !record(value.audit) || !keys(value.audit, ['traceId', 'attribution']) || !text(value.audit.traceId)
    || !attribution(value.audit.attribution) || !selections(value.journalDocuments, true)
    || (value.operation !== 'document' && !selections(value.expectationDocuments, false))) return undefined;
  if ((value.operation === 'reload') !== (value.audit.attribution.kind === 'principal')) return undefined;
  if (value.operation === 'profile' && value.sourceReceipt !== null) {
    const receipt = value.sourceReceipt;
    if (!record(receipt) || !keys(receipt, ['applicationId', 'revision'])
      || typeof receipt.applicationId !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.applicationId)
      || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1) return undefined;
  }
  return value as unknown as ContextWritePlan;
}

export function contextWritePlanMatches(
  plan: ContextWritePlan,
  documents: readonly { readonly name: string; readonly path: string; readonly targetSha: string | null }[],
  snapshot: { readonly revision: number | null; readonly expectation: {
    readonly documents: readonly ContextWriteSelection[];
  } | null },
): boolean {
  const selected = (selection: ContextWriteSelection): boolean => documents.some((document) =>
    document.name === selection.name && document.path === selection.path && document.targetSha !== null);
  if (!plan.journalDocuments.every(selected)) return false;
  if (plan.operation === 'document') return documents.length === 1 && plan.journalDocuments.length === 1;
  if (snapshot.revision === null || !plan.expectationDocuments.every(selected)) return false;
  if (plan.operation === 'profile' && plan.sourceReceipt !== null && plan.sourceReceipt.revision !== snapshot.revision) return false;
  return plan.operation !== 'reconcile' || (snapshot.expectation !== null
    && snapshot.expectation.documents.length === plan.expectationDocuments.length
    && snapshot.expectation.documents.every((document) => plan.expectationDocuments.some((item) =>
      item.name === document.name && item.path === document.path)));
}

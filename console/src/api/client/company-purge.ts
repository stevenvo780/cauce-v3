import { ApiError } from './core';

export interface CompanyPurgeReceipt {
  company_id: string; deletion: 'purged'; backup_path: string; deleted_rows: Record<string, number>;
}
export interface CompanyPurgeBlocker { kind: string; id: string }

export class CompanyPurgeBlockedError extends ApiError {
  constructor(readonly blockers: CompanyPurgeBlocker[]) {
    super('La empresa conserva recursos o referencias pendientes.', 409, 'company_purge_blocked');
    this.name = 'CompanyPurgeBlockedError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function companyPurgeError(status: number, value: unknown): Error | undefined {
  const body = object(value);
  if (status !== 409 || body?.error !== 'company_purge_blocked' || !Array.isArray(body.blockers)) return undefined;
  const blockers: CompanyPurgeBlocker[] = [];
  for (const value of body.blockers as unknown[]) {
    const item = object(value);
    if (!item || typeof item.kind !== 'string' || !item.kind || typeof item.id !== 'string' || !item.id) return undefined;
    blockers.push({ kind: item.kind, id: item.id });
  }
  return blockers.length ? new CompanyPurgeBlockedError(blockers) : undefined;
}

export function companyPurgeReceipt(value: unknown, company: string): CompanyPurgeReceipt {
  const row = object(value); const counts = object(row?.deleted_rows);
  if (row?.company_id !== company || row.deletion !== 'purged'
    || typeof row.backup_path !== 'string' || !row.backup_path.trim()
    || counts?.companies !== 1 || !Object.values(counts).every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
    throw new ApiError('El servidor no confirmó la copia y los conteos de la purga. Relee la empresa antes de continuar.', 502, 'invalid_company_purge_receipt');
  }
  return row as unknown as CompanyPurgeReceipt;
}

import { NativeAdminOutcomeSchema, NativePieceKindSchema, NativePieceMutationSchema, NativeRuntimeIdentitySchema,
  type NativeAdminOutcome, type NativePieceKind, type NativePieceMutation, type NativeRuntimeIdentity } from '@cauce/protocol/native-admin';
import { ApiError } from '../../../api/client/core';
import type { RequestFn } from '../../../api/client/system-client';

export interface NativeRead {
  tenant_id: string; alias: string; harness: string; kinds: NativePieceKind[]; can_write: boolean;
  identity: NativeRuntimeIdentity; outcome: Exclude<NativeAdminOutcome, { type: 'error' }>;
}
export interface NativeSaved {
  tenant_id: string; alias: string; state: 'written_pending_reload'; action: 'put' | 'delete';
  receipt: Extract<NativeAdminOutcome, { type: 'receipt' }>;
}
export class NativeAdminUnconfirmedError extends ApiError {
  constructor(readonly operationId: string) { super('La respuesta no acreditó el efecto. Conserva el borrador y verifica la operación antes de reintentar.', 503, 'native_effect_unknown'); }
}
export interface NativeAdminClient {
  nativeAdminEpoch(): number;
  discoverNativePiece(tenantId: string, alias: string, mutation: NativePieceMutation, identity: NativeRuntimeIdentity, operationId?: string): Promise<{ state: 'pending'; operation_id: string } | { state: 'not_found'; operation_id: null }>;
  recoverNativePiece(tenantId: string, alias: string, operationId: string, mutation: NativePieceMutation): Promise<NativeSaved | { state: 'not_applied'; operation_id: string }>;
  recognizeNativePiece(tenantId: string, alias: string, kind: NativePieceKind, id: string, expectedSha: string | null, expectedIdentity: NativeRuntimeIdentity): Promise<Extract<NativeAdminOutcome, { type: 'recognition' }>>;
  readNativePieces(tenantId: string, alias: string, kind: NativePieceKind, id?: string): Promise<NativeRead>;
  mutateNativePiece(tenantId: string, alias: string, mutation: NativePieceMutation, reason: string, identity: NativeRuntimeIdentity, operationId?: string): Promise<NativeSaved>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El servidor no acreditó las piezas nativas.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('El servidor devolvió un recibo nativo incompatible.');
}
export function nativeAdminClient(request: RequestFn, epoch: () => number): NativeAdminClient {
  const path = (tenant: string, alias: string, kind: NativePieceKind, id?: string) => `/v3/console/tenants/${encodeURIComponent(tenant)}/agents/${encodeURIComponent(alias)}/native/${kind}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
  const options = { requireCsrf: true, mapError: (status: number, body: unknown) => {
    if (status === 503 && body && typeof body === 'object' && !Array.isArray(body) && 'operation_id' in body && 'state' in body
      && body.state === 'effect_unknown' && typeof body.operation_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(body.operation_id)) return new NativeAdminUnconfirmedError(body.operation_id);
    return new ApiError(status === 409
    ? 'La huella o el runtime cambió. Relee la pieza; se conserva el borrador.'
    : status === 501 ? 'Este arnés o esta cuenta no publica edición nativa para este tipo.'
      : 'No se confirmó la operación nativa. Se conserva el borrador.', status, 'native_admin_failed'); } };
  async function call(url: string, init: RequestInit = {}) {
    const before = epoch(); const value = await request(url, { cache: 'no-store', ...init }, options);
    if (before !== epoch()) throw new Error('La sesión cambió; no se acredita el resultado anterior.');
    return record(value);
  }
  return {
    nativeAdminEpoch: epoch,
    discoverNativePiece: async (tenant, alias, mutation, identity, operationId) => {
      const result = await call(path(tenant, alias, mutation.kind, mutation.id) + '/discover', { method: 'POST',
        body: JSON.stringify({ mutation: NativePieceMutationSchema.parse(mutation), identity: NativeRuntimeIdentitySchema.parse(identity),
          ...(operationId === undefined ? {} : { operation_id: operationId }) }) });
      exact(result, ['tenant_id', 'alias', 'identity', 'state', 'operation_id']);
      const actualIdentity = NativeRuntimeIdentitySchema.parse(result.identity);
      if (result.tenant_id !== tenant || result.alias !== alias || JSON.stringify(actualIdentity) !== JSON.stringify(identity)) throw new Error('El descubrimiento pertenece a otro destino o runtime.');
      if (result.state === 'not_found' && result.operation_id === null) return { state: 'not_found', operation_id: null };
      if (result.state !== 'pending' || typeof result.operation_id !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result.operation_id)
        || (operationId !== undefined && result.operation_id !== operationId)) throw new Error('No se acreditó la operación pendiente original.');
      return { state: 'pending', operation_id: result.operation_id };
    },
    recoverNativePiece: async (tenant, alias, operationId, mutation) => {
      const result = await call(path(tenant, alias, mutation.kind, mutation.id) + '/recover', { method: 'POST', body: JSON.stringify({ operation_id: operationId, mutation }) });
      if (result.state === 'not_applied') {
        exact(result, ['tenant_id', 'alias', 'state', 'operation_id']);
        if (result.tenant_id !== tenant || result.alias !== alias || result.operation_id !== operationId) throw new Error('La recuperación pertenece a otra operación.');
        return { state: 'not_applied', operation_id: operationId };
      }
      exact(result, ['tenant_id', 'alias', 'state', 'action', 'receipt']); const receipt = NativeAdminOutcomeSchema.parse(result.receipt);
      if (result.tenant_id !== tenant || result.alias !== alias || result.state !== 'written_pending_reload' || result.action !== mutation.action
        || receipt.type !== 'receipt' || receipt.kind !== mutation.kind || receipt.id !== mutation.id || receipt.operation_id !== operationId) throw new Error('No se acreditó la recuperación nativa.');
      return { tenant_id: tenant, alias, state: 'written_pending_reload', action: mutation.action, receipt };
    },
    recognizeNativePiece: async (tenant, alias, kind, id, expectedSha, expectedIdentity) => {
      const result = await call(path(tenant, alias, kind, id) + '/recognize', { method: 'POST', body: JSON.stringify({ expected_sha: expectedSha, identity: NativeRuntimeIdentitySchema.parse(expectedIdentity) }) });
      exact(result, ['tenant_id', 'alias', 'identity', 'outcome']); const identity = NativeRuntimeIdentitySchema.parse(result.identity);
      const outcome = NativeAdminOutcomeSchema.parse(result.outcome);
      if (result.tenant_id !== tenant || result.alias !== alias || outcome.type !== 'recognition' || outcome.kind !== kind || outcome.id !== id || outcome.sha !== expectedSha
        || JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) throw new Error('El proveedor no acreditó esta pieza y su escritor.');
      return outcome;
    },
    readNativePieces: async (tenant, alias, kind, id) => {
      const result = await call(path(tenant, alias, kind, id));
      exact(result, ['tenant_id', 'alias', 'identity', 'harness', 'kinds', 'can_write', 'outcome']);
      const identity = NativeRuntimeIdentitySchema.parse(result.identity);
      const outcome = NativeAdminOutcomeSchema.parse(result.outcome);
      if (result.tenant_id !== tenant || result.alias !== alias || typeof result.harness !== 'string'
        || typeof result.can_write !== 'boolean' || !Array.isArray(result.kinds) || outcome.type === 'error'
        || (id === undefined ? outcome.type !== 'inventory' || outcome.kind !== kind
          : outcome.type !== 'piece' || outcome.piece.kind !== kind || outcome.piece.id !== id)) throw new Error('La pieza pertenece a otro destino o no se confirmó.');
      return { tenant_id: tenant, alias, identity, harness: result.harness, can_write: result.can_write,
        kinds: result.kinds.map(value => NativePieceKindSchema.parse(value)), outcome };
    },
    mutateNativePiece: async (tenant, alias, mutation, reason, identity, operationId) => {
      const checked = NativePieceMutationSchema.parse(mutation);
      const result = await call(path(tenant, alias, checked.kind, checked.id), { method: 'PUT',
        body: JSON.stringify({ mutation: checked, reason, identity: NativeRuntimeIdentitySchema.parse(identity), ...(operationId === undefined ? {} : { operation_id: operationId }) }) });
      exact(result, ['tenant_id', 'alias', 'state', 'action', 'receipt']);
      const receipt = NativeAdminOutcomeSchema.parse(result.receipt);
      if (result.tenant_id !== tenant || result.alias !== alias || result.state !== 'written_pending_reload'
        || result.action !== checked.action || receipt.type !== 'receipt' || receipt.kind !== checked.kind || receipt.id !== checked.id
        || (operationId !== undefined && receipt.operation_id !== operationId)) throw new Error('El servidor no acreditó este guardado nativo.');
      return { tenant_id: tenant, alias, state: 'written_pending_reload', action: checked.action, receipt };
    },
  };
}

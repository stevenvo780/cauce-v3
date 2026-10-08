import type { NativePieceKind, NativePieceMutation, NativeRuntimeIdentity } from '@cauce/protocol/native-admin';
import type { NativeAdminClient, NativeRead } from './client';

export interface NativeDraft { kind: NativePieceKind; id: string; content: string; url: string; env: string; reason: string; base?: NativeRead; pending?: { operationId: string; mutation: NativePieceMutation; identity: NativeRuntimeIdentity } }
const drafts = new WeakMap<NativeAdminClient, { epoch: number; values: Map<string, NativeDraft> }>();
function bucket(api: NativeAdminClient) {
  let current = drafts.get(api);
  if (current?.epoch !== api.nativeAdminEpoch()) {
    current = { epoch: api.nativeAdminEpoch(), values: new Map() }; drafts.set(api, current);
  }
  return current;
}
export function readNativeDraft(api: NativeAdminClient, tenant: string, alias: string): NativeDraft | undefined {
  return bucket(api).values.get(JSON.stringify([tenant, alias]));
}
export function storeNativeDraft(api: NativeAdminClient, tenant: string, alias: string, draft?: NativeDraft): void {
  const values = bucket(api).values; const key = JSON.stringify([tenant, alias]);
  if (!draft) { values.delete(key); return; }
  values.set(key, draft);
  const discardable = [...values.entries()].filter(([, value]) => value.pending === undefined);
  for (const [oldest] of discardable.slice(0, Math.max(0, discardable.length - 20))) values.delete(oldest);
}
export function clearNativeDrafts(api: NativeAdminClient): void { drafts.delete(api); }

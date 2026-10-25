import type { RequestFn } from './system-client';
import { versionedContext } from './v4-responses';

export interface VersionedContextFile { path: string; content: string }
export interface VersionedContextSnapshot {
  version: number; files: VersionedContextFile[]; desired_version: number; applied_version: number | null;
  sync: { state: 'pending' | 'synced' | 'error'; git_commit: string | null; pushed_at: string | null; last_error: string | null };
  application: { state: 'pending' | 'applied' | 'error'; last_error: string | null };
}
export interface ContextVersionEntry { version: number; source: string; restored_from: number | null; created_at: string; actor_human_id: string | null; actor_alias: string; actor_name?: string | null; digest: string }
export interface ContextVersions { entries: ContextVersionEntry[]; next_cursor: number | null }
export interface ContextVersionDiff { from: number; to: number; files: { path: string; before: string | null; after: string | null; change: 'added' | 'modified' | 'deleted' }[] }
export interface ContextVersionsClient {
  getVersionedContext(tenant: string, alias: string): Promise<VersionedContextSnapshot>;
  saveVersionedContext(tenant: string, alias: string, input: { expected_version: number; files: VersionedContextFile[]; source: 'ui' }): Promise<VersionedContextSnapshot>;
  getContextVersions(tenant: string, alias: string, cursor?: number): Promise<ContextVersions>;
  getContextVersionDiff(tenant: string, alias: string, from: number, to: number): Promise<ContextVersionDiff>;
  restoreContextVersion(tenant: string, alias: string, input: { expected_version: number; version: number }): Promise<VersionedContextSnapshot>;
  retryContextSync(tenant: string, alias: string): Promise<unknown>;
  applyVersionedContext(tenant: string, alias: string): Promise<unknown>;
}
export function contextVersionsClient(request: RequestFn): ContextVersionsClient {
  const path = (tenant: string, alias: string) => `/v3/console/context/agents/${encodeURIComponent(tenant)}/${encodeURIComponent(alias)}`;
  const post = <T>(url: string, input?: unknown) => request<T>(url, { method: 'POST', ...(input ? { body: JSON.stringify(input) } : {}) });
  return {
    getVersionedContext: async (tenant, alias) => versionedContext(await request(path(tenant, alias), { cache: 'no-store' })),
    saveVersionedContext: async (tenant, alias, input) => versionedContext(await request(path(tenant, alias), { method: 'PUT', body: JSON.stringify(input) })),
    getContextVersions: (tenant, alias, cursor) => request(`${path(tenant, alias)}/history${cursor === undefined ? '' : `?before=${String(cursor)}`}`, { cache: 'no-store' }),
    getContextVersionDiff: (tenant, alias, from, to) => request(`${path(tenant, alias)}/diff?from=${String(from)}&to=${String(to)}`),
    restoreContextVersion: async (tenant, alias, input) => versionedContext(await post(path(tenant, alias) + '/restore', input)),
    retryContextSync: (tenant, alias) => post(path(tenant, alias) + '/sync/retry'),
    applyVersionedContext: (tenant, alias) => post(path(tenant, alias) + '/apply'),
  };
}

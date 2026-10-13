import type { RouteIsolationEntry } from './route-isolation-matrix.js';

/** Shared by the local guard and the external runner, so both expand the same matrix the same way. */
export const ISOLATION_OAUTH_ISSUER = 'https://isolation.example.test';

export interface ProbeSide { readonly tenant: string; readonly alias: string; readonly room: string; readonly ownerAlias: string }
export interface ExpandedProbe { url: string; payload?: unknown; headers?: Record<string, string> }

export function routeKey(method: string, url: string): string { return `${method === 'HEAD' ? 'GET' : method} ${url}`; }

/** Placeholders a probe references, in its URL, payload and headers. */
export function probePlaceholders(entry: RouteIsolationEntry): string[] {
  const probe = entry.probe;
  if (!probe) return [];
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') for (const match of value.matchAll(/\{(\w+)\}/gu)) found.add(match[1] ?? '');
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(probe.url); visit(probe.payload); visit(probe.headers);
  found.delete('');
  return [...found];
}

export function expandProbe(entry: RouteIsolationEntry, fixture: ProbeSide, own: ProbeSide): ExpandedProbe {
  const values: Record<string, unknown> = { ...fixture, director: fixture.alias, tenantId: fixture.tenant,
    ownRoom: own.room, ownTenant: own.tenant, ownAlias: own.ownerAlias, issuer: ISOLATION_OAUTH_ISSUER };
  const expand = (text: string): string => text.replace(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`missing real fixture ${name} for ${entry.method} ${entry.url}`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`non-scalar path fixture ${name}`);
    return String(value);
  });
  const probe = entry.probe;
  if (!probe) return { url: entry.url };
  const expandPayload = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = /^\{(\w+)\}$/u.exec(value)?.[1];
      if (exact !== undefined) {
        if (exact === 'csrf') return value;
        if (values[exact] === undefined) throw new Error(`missing real fixture ${exact} for ${entry.url}`);
        return values[exact];
      }
      return expand(value);
    }
    if (Array.isArray(value)) return value.map(expandPayload);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expandPayload(field)]));
    return value;
  };
  const headers = probe.headers === undefined ? undefined
    : Object.fromEntries(Object.entries(probe.headers).map(([key, value]) => [key, expand(value)]));
  return { url: expand(probe.url), ...(probe.payload === undefined ? {} : { payload: expandPayload(probe.payload) }),
    ...(headers === undefined ? {} : { headers }) };
}

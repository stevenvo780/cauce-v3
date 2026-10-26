import type {
  AdapterPage,
  AuditPage,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  ConsoleAccess,
  ObservabilitySnapshot,
  PlatformCatalogSnapshot,
  PlatformHarnessCreate,
  PlatformHarnessUpdate,
  PlatformRolePolicyCreate,
  PlatformRolePolicyUpdate,
  SystemStatus,
  TopologySnapshot,
} from '../types';
import { auditFilterProblem, type AuditFilterDraft } from '../audit-server-filters';
import { ApiError, type RequestOptions } from './core';

export type RequestFn = <T>(path: string, init?: RequestInit, options?: RequestOptions) => Promise<T>;

export function getStatus(request: RequestFn): Promise<SystemStatus> {
  return request('/v3/status');
}

export async function getConsoleAccess(request: RequestFn): Promise<ConsoleAccess> {
  try {
    return await request('/v3/console/access');
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
      return { permissions: null, roles: null, reason: 'El servidor no publicó los permisos de forma verificable.' };
    }
    if (error instanceof ApiError && error.status === 403) {
      return { permissions: [], roles: [], reason: 'El servidor denegó la consulta de permisos.' };
    }
    throw error;
  }
}

export function getTopology(request: RequestFn): Promise<TopologySnapshot> {
  return request('/v3/console/topology');
}

export function listAdapters(request: RequestFn): Promise<AdapterPage> {
  return request('/v3/console/adapters');
}

export interface AuditListOptions {
  limit?: number;
  before?: string;
  trace_id?: string;
  alias?: string;
  action?: string;
  from?: string;
  to?: string;
  signal?: AbortSignal;
}

function auditDraft(options: AuditListOptions): AuditFilterDraft {
  return {
    trace: options.trace_id ?? '',
    alias: options.alias ?? '',
    action: options.action ?? '',
    from: options.from ?? '',
    to: options.to ?? '',
  };
}

export function listAudit(request: RequestFn, options: AuditListOptions = {}): Promise<AuditPage> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('Audit limit must be an integer between 1 and 500');
  }
  if (options.before !== undefined && (
    !/^[1-9][0-9]{0,18}$/u.test(options.before)
    || BigInt(options.before) > 9_223_372_036_854_775_807n
  )) {
    throw new RangeError('Audit cursor must be a canonical positive bigint');
  }
  const problem = auditFilterProblem(auditDraft(options));
  if (problem !== undefined) throw new RangeError(problem);
  const query = new URLSearchParams({ limit: String(limit) });
  if (options.before !== undefined) query.set('before', options.before);
  if (options.trace_id) query.set('trace_id', options.trace_id);
  if (options.alias) query.set('alias', options.alias);
  if (options.action) query.set('action', options.action);
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  return request(`/v3/console/audit?${query.toString()}`, { signal: options.signal });
}

export interface DiagnosticChainItem {
  type: string;
  id: string;
  at?: string;
  action?: string;
  state?: string;
  alias?: string;
  decision?: string;
  trace_id?: string;
}

export interface DiagnosticChain {
  id: string;
  company_id?: string;
  truncated: boolean;
  items: DiagnosticChainItem[];
}

function diagnosticText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseDiagnosticChain(value: unknown): DiagnosticChain {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('El servidor no devolvió una cadena.');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.id !== 'string' || !Array.isArray(body.items) || typeof body.truncated !== 'boolean') {
    throw new Error('El servidor no devolvió una cadena.');
  }
  const items = body.items.map((item): DiagnosticChainItem => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('La cadena trae un nodo ilegible.');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.type !== 'string' || typeof row.id !== 'string') {
      throw new Error('La cadena trae un nodo ilegible.');
    }
    return {
      type: row.type,
      id: row.id,
      at: diagnosticText(row.at),
      action: diagnosticText(row.action),
      state: diagnosticText(row.state),
      alias: diagnosticText(row.alias),
      decision: diagnosticText(row.decision),
      trace_id: diagnosticText(row.trace_id),
    };
  });
  return {
    id: body.id,
    company_id: diagnosticText(body.company_id),
    truncated: body.truncated,
    items,
  };
}

function diagnosticIdentifier(value: string): string {
  const identifier = value.trim();
  if (identifier.length < 1 || identifier.length > 256 || identifier === '.' || identifier === '..'
    || Array.from(identifier).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) {
    throw new RangeError('Diagnostic identifier is invalid');
  }
  return identifier;
}

export function getDiagnosticChain(request: RequestFn, identifier: string): Promise<DiagnosticChain> {
  const id = diagnosticIdentifier(identifier);
  return request<unknown>(`/v3/console/diagnose/${encodeURIComponent(id)}`).then(parseDiagnosticChain);
}

export function getConfiguration(request: RequestFn): Promise<ConfigurationSnapshot> {
  return request('/v3/console/config');
}

export function changeConfiguration(
  request: RequestFn,
  mutation: ConfigMutation,
  options: { dryRun: boolean; expectedRevision?: number },
): Promise<ConfigurationChangeResult> {
  return request('/v3/console/config/changes', {
    method: 'POST',
    body: JSON.stringify({
      dry_run: options.dryRun,
      mutation,
      ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
    }),
  });
}

export function rollbackConfiguration(
  request: RequestFn,
  revisionId: string,
  options: { dryRun: boolean; expectedRevision?: number },
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/config/revisions/${encodeURIComponent(revisionId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({
      dry_run: options.dryRun,
      ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
    }),
  });
}

export function getObservability(request: RequestFn): Promise<ObservabilitySnapshot> {
  return request('/v3/console/observability');
}

export function getPlatformCatalog(request: RequestFn): Promise<PlatformCatalogSnapshot> {
  return request('/v3/console/platform/catalog');
}

export function createPlatformHarness(
  request: RequestFn, input: PlatformHarnessCreate,
): Promise<ConfigurationChangeResult> {
  return request('/v3/console/platform/harnesses', { method: 'POST', body: JSON.stringify(input) });
}

export function updatePlatformHarness(
  request: RequestFn, id: string, input: PlatformHarnessUpdate,
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/platform/harnesses/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
}

export function deletePlatformHarness(
  request: RequestFn, id: string, expectedRevision: number,
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/platform/harnesses/${encodeURIComponent(id)}?expected_revision=${String(expectedRevision)}`, {
    method: 'DELETE',
  });
}

export function createPlatformRolePolicy(
  request: RequestFn, input: PlatformRolePolicyCreate,
): Promise<ConfigurationChangeResult> {
  return request('/v3/console/platform/role-policies', { method: 'POST', body: JSON.stringify(input) });
}

export function updatePlatformRolePolicy(
  request: RequestFn, role: string, input: PlatformRolePolicyUpdate,
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/platform/role-policies/${encodeURIComponent(role)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
}

export function deletePlatformRolePolicy(
  request: RequestFn, role: string, expectedRevision: number,
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/platform/role-policies/${encodeURIComponent(role)}?expected_revision=${String(expectedRevision)}`, {
    method: 'DELETE',
  });
}

export interface SystemClient {
  getStatus(): Promise<SystemStatus>;
  getConsoleAccess(): Promise<ConsoleAccess>;
  getTopology(): Promise<TopologySnapshot>;
  listAdapters(): Promise<AdapterPage>;
  listAudit(options?: AuditListOptions): Promise<AuditPage>;
  getDiagnosticChain(identifier: string): Promise<DiagnosticChain>;
  getConfiguration(): Promise<ConfigurationSnapshot>;
  changeConfiguration(
    mutation: ConfigMutation,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult>;
  rollbackConfiguration(
    revisionId: string,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult>;
  getObservability(): Promise<ObservabilitySnapshot>;
  getPlatformCatalog(): Promise<PlatformCatalogSnapshot>;
  createPlatformHarness(input: PlatformHarnessCreate): Promise<ConfigurationChangeResult>;
  updatePlatformHarness(id: string, input: PlatformHarnessUpdate): Promise<ConfigurationChangeResult>;
  deletePlatformHarness(id: string, expectedRevision: number): Promise<ConfigurationChangeResult>;
  createPlatformRolePolicy(input: PlatformRolePolicyCreate): Promise<ConfigurationChangeResult>;
  updatePlatformRolePolicy(role: string, input: PlatformRolePolicyUpdate): Promise<ConfigurationChangeResult>;
  deletePlatformRolePolicy(role: string, expectedRevision: number): Promise<ConfigurationChangeResult>;
}

export function systemClient(request: RequestFn): SystemClient {
  return {
    getStatus: () => getStatus(request),
    getConsoleAccess: () => getConsoleAccess(request),
    getTopology: () => getTopology(request),
    listAdapters: () => listAdapters(request),
    listAudit: (options) => listAudit(request, options),
    getDiagnosticChain: (identifier) => getDiagnosticChain(request, identifier),
    getConfiguration: () => getConfiguration(request),
    changeConfiguration: (mutation, options) => changeConfiguration(request, mutation, options),
    rollbackConfiguration: (revisionId, options) => rollbackConfiguration(request, revisionId, options),
    getObservability: () => getObservability(request),
    getPlatformCatalog: () => getPlatformCatalog(request),
    createPlatformHarness: (input) => createPlatformHarness(request, input),
    updatePlatformHarness: (id, input) => updatePlatformHarness(request, id, input),
    deletePlatformHarness: (id, expectedRevision) => deletePlatformHarness(request, id, expectedRevision),
    createPlatformRolePolicy: (input) => createPlatformRolePolicy(request, input),
    updatePlatformRolePolicy: (role, input) => updatePlatformRolePolicy(request, role, input),
    deletePlatformRolePolicy: (role, expectedRevision) => deletePlatformRolePolicy(request, role, expectedRevision),
  };
}

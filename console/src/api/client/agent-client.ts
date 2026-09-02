import type {
  AgentDirective,
  AgentDocumentContent,
  AgentDocumentGuardado,
  AgentDocumentKind,
  AgentDocumentsMap,
  AgentPerfil,
  AgentPerfilValor,
  FleetActivitySnapshot,
  RoleBriefHistory,
  TerminalCapability,
} from '../types';
import { ApiError } from './core';
import type { RequestFn } from './system-client';

export function getFleetActivity(request: RequestFn): Promise<FleetActivitySnapshot> {
  return request('/v3/console/activity');
}

export async function getAgentDirective(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentDirective> {
  const ruta = `/v3/console/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/directive`;
  try {
    const cuerpo = await request<Omit<AgentDirective, 'publicado'>>(ruta);
    return { ...cuerpo, publicado: true };
  } catch (error) {
    if (error instanceof ApiError
      && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
      return {
        publicado: false,
        motivo: `Este gateway no publica GET ${ruta} (respondió ${String(error.status)}).`,
      };
    }
    throw error;
  }
}

export async function getRoleBriefHistory(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<RoleBriefHistory> {
  const ruta = `/v3/console/role-assignments/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/history`;
  try {
    const cuerpo = await request<Omit<RoleBriefHistory, 'publicado'>>(ruta);
    return { ...cuerpo, publicado: true };
  } catch (error) {
    if (error instanceof ApiError
      && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
      return {
        publicado: false,
        motivo: `Este gateway no publica GET ${ruta} (respondió ${String(error.status)}).`,
      };
    }
    throw error;
  }
}

export async function getAgentDocuments(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentDocumentsMap> {
  const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents`;
  try {
    const cuerpo = await request<Omit<AgentDocumentsMap, 'publicado'>>(ruta);
    return { ...cuerpo, publicado: true };
  } catch (error) {
    if (error instanceof ApiError
      && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
      return {
        publicado: false,
        motivo: `Este gateway no publica GET ${ruta} (respondió ${String(error.status)}).`,
      };
    }
    throw error;
  }
}

export async function getAgentDocumentContent(
  request: RequestFn,
  tenantId: string,
  alias: string,
  kind: AgentDocumentKind,
): Promise<AgentDocumentContent> {
  const value = await request<unknown>(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/content`,
  );
  const malformed = (): never => {
    throw new ApiError(
      'El gateway devolvió un contenido de documento incompleto o incoherente; no se mostrará como si el fichero estuviera vacío.',
      502,
      'invalid_document_content',
    );
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed();
  const row = value as Record<string, unknown>;
  const path = row.path;
  const exists = row.exists;
  const content = row.content;
  const sha = row.sha;
  const bytes = row.bytes;
  const truncated = row.truncated;
  if (row.tenant_id !== tenantId || row.alias !== alias || row.kind !== kind
      || typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')
      || path.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
      || typeof row.format !== 'string' || row.format.length === 0
      || typeof exists !== 'boolean' || typeof content !== 'string'
      || !(sha === null || (typeof sha === 'string' && /^[0-9a-f]{64}$/u.test(sha)))
      || !Number.isSafeInteger(bytes) || Number(bytes) < 0
      || typeof row.editable !== 'boolean' || typeof truncated !== 'boolean'
      || typeof row.projected !== 'boolean'
      || (row.modified_at !== undefined && typeof row.modified_at !== 'string')
      || (row.warning !== undefined && typeof row.warning !== 'string')) return malformed();

  const visibleBytes = new TextEncoder().encode(content).byteLength;
  if ((!exists && (content !== '' || sha !== null || bytes !== 0 || truncated))
      || (exists && typeof sha !== 'string')
      || visibleBytes > Number(bytes)
      || (!truncated && visibleBytes !== Number(bytes))
      || (truncated && row.editable)) return malformed();
  return value as AgentDocumentContent;
}

export function putAgentDocumentContent(
  request: RequestFn,
  tenantId: string,
  alias: string,
  kind: AgentDocumentKind,
  content: string,
  expectedSha: string | null,
): Promise<AgentDocumentGuardado> {
  return request<AgentDocumentGuardado>(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expectedSha === null
        ? { content, create_if_absent: true }
        : { content, expected_sha: expectedSha }),
    },
  );
}

export async function getAgentPerfil(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentPerfil> {
  const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`;
  try {
    const cuerpo = await request<Omit<AgentPerfil, 'publicado'>>(ruta);
    return { ...cuerpo, publicado: true };
  } catch (error) {
    if (error instanceof ApiError
      && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
      return {
        publicado: false,
        motivo: `Este gateway no publica GET ${ruta} (respondió ${String(error.status)}).`,
        perfil: {
          purpose: null, role_summary: null, human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: [],
        },
      };
    }
    throw error;
  }
}

export function putAgentPerfil(
  request: RequestFn,
  tenantId: string,
  alias: string,
  profile: AgentPerfilValor,
  expectedRevision: number | null,
): Promise<unknown> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`,
    {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: expectedRevision, profile }),
    },
  );
}

export async function getTerminalCapability(request: RequestFn): Promise<TerminalCapability> {
  try {
    return await request('/v3/console/terminal/capability');
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
      return { available: false, reason: 'Backend PTY no disponible' };
    }
    throw error;
  }
}

export interface AgentClient {
  getFleetActivity(): Promise<FleetActivitySnapshot>;
  getAgentDirective(tenantId: string, alias: string): Promise<AgentDirective>;
  getRoleBriefHistory(tenantId: string, alias: string): Promise<RoleBriefHistory>;
  getAgentDocuments(tenantId: string, alias: string): Promise<AgentDocumentsMap>;
  getAgentDocumentContent(tenantId: string, alias: string, kind: AgentDocumentKind): Promise<AgentDocumentContent>;
  putAgentDocumentContent(
    tenantId: string,
    alias: string,
    kind: AgentDocumentKind,
    content: string,
    expectedSha: string | null,
  ): Promise<AgentDocumentGuardado>;
  getAgentPerfil(tenantId: string, alias: string): Promise<AgentPerfil>;
  putAgentPerfil(
    tenantId: string,
    alias: string,
    profile: AgentPerfilValor,
    expectedRevision: number | null,
  ): Promise<unknown>;
  getTerminalCapability(): Promise<TerminalCapability>;
}

export function agentClient(request: RequestFn): AgentClient {
  return {
    getFleetActivity: () => getFleetActivity(request),
    getAgentDirective: (tenantId, alias) => getAgentDirective(request, tenantId, alias),
    getRoleBriefHistory: (tenantId, alias) => getRoleBriefHistory(request, tenantId, alias),
    getAgentDocuments: (tenantId, alias) => getAgentDocuments(request, tenantId, alias),
    getAgentDocumentContent: (tenantId, alias, kind) => getAgentDocumentContent(request, tenantId, alias, kind),
    putAgentDocumentContent: (tenantId, alias, kind, content, expectedSha) =>
      putAgentDocumentContent(request, tenantId, alias, kind, content, expectedSha),
    getAgentPerfil: (tenantId, alias) => getAgentPerfil(request, tenantId, alias),
    putAgentPerfil: (tenantId, alias, profile, expectedRevision) =>
      putAgentPerfil(request, tenantId, alias, profile, expectedRevision),
    getTerminalCapability: () => getTerminalCapability(request),
  };
}

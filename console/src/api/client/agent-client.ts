import type {
  AgentDirective,
  AgentDocumentContent,
  AgentDocumentGuardado,
  AgentDocumentKind,
  AgentDocumentsMap,
  AgentPerfil,
  AgentPerfilValor,
  FleetActivitySnapshot,
  TerminalCapability,
} from '../types';
import type {
  PaginaDeRevisiones, PaginaDeRevisionesDeDocumento, PerfilRevision, TramoDeRevisiones,
} from '../../features/live/perfil';
import { ApiError, errorBody } from './core';
import type { RequestFn } from './system-client';

async function getPublishedResource<T extends object>(
  load: () => Promise<T>,
  route: string,
  unavailable: T,
): Promise<T & { publicado: boolean; motivo?: string }> {
  try {
    return { ...await load(), publicado: true };
  } catch (error) {
    if (error instanceof ApiError
      && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
      return {
        ...unavailable,
        publicado: false,
        motivo: `Este gateway no publica GET ${route} (respondió ${String(error.status)}).`,
      };
    }
    throw error;
  }
}

export function getFleetActivity(request: RequestFn): Promise<FleetActivitySnapshot> {
  return request('/v3/console/activity');
}

export async function getAgentDirective(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentDirective> {
  const ruta = `/v3/console/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/directive`;
  return getPublishedResource<Omit<AgentDirective, 'publicado' | 'motivo'>>(
    () => request<Omit<AgentDirective, 'publicado' | 'motivo'>>(ruta),
    ruta,
    {},
  );
}

export async function getAgentDocuments(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentDocumentsMap> {
  const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents`;
  return getPublishedResource<Omit<AgentDocumentsMap, 'publicado' | 'motivo'>>(
    () => request<Omit<AgentDocumentsMap, 'publicado' | 'motivo'>>(ruta),
    ruta,
    {},
  );
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

/**
 * Both 403s of this route answer `error: 'forbidden'`; only `reason` tells an unattributed session
 * apart from a path that mixes credentials, and the two need opposite words on screen.
 */
function sesionSinPersona(status: number, body: unknown): ApiError | undefined {
  const detalle = errorBody(body);
  if (status !== 403 || detalle.reason !== 'writable_requires_attribution') return undefined;
  return new ApiError(
    detalle.message
      ?? 'Escribir la gobernanza de un alias exige una persona con nombre; esta sesión no la tiene.',
    403,
    'writable_requires_attribution',
  );
}

/**
 * `reason` is prose a person typed for THIS save. The gateway refuses a body without it and never
 * invents one, so it is a parameter and never a default built here.
 */
export function putAgentDocumentContent(
  request: RequestFn,
  tenantId: string,
  alias: string,
  kind: AgentDocumentKind,
  content: string,
  expectedSha: string | null,
  reason: string,
): Promise<AgentDocumentGuardado> {
  return request<AgentDocumentGuardado>(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expectedSha === null
        ? { content, reason, create_if_absent: true }
        : { content, reason, expected_sha: expectedSha }),
    },
    { mapError: sesionSinPersona },
  );
}

export async function getAgentPerfil(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentPerfil> {
  const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`;
  return getPublishedResource<Omit<AgentPerfil, 'publicado' | 'motivo'>>(
    () => request<Omit<AgentPerfil, 'publicado' | 'motivo'>>(ruta),
    ruta,
    {
      perfil: {
        purpose: null, role_summary: null, human_brief: null,
        responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      },
    },
  );
}

/**
 * Two 409s that carry more than a sentence: the verdict that names WHOSE block is in the way, and
 * the deliveries a reload refuses to run over. A generic `ApiError` drops the body and the screen
 * would then quarantine without being able to say what for, so the body travels with the error and
 * the view that speaks that vocabulary is the one that reads it.
 */
export class ContextoContaminadoError extends ApiError {
  constructor(message: string, readonly cuerpo: unknown) {
    super(message, 409, 'context_contaminated');
    this.name = 'ContextoContaminadoError';
  }
}

export class EntregaEnVueloError extends ApiError {
  constructor(message: string, readonly cuerpo: unknown) {
    super(message, 409, 'delivery_in_flight');
    this.name = 'EntregaEnVueloError';
  }
}

/**
 * A 400 of the audit admission is not a 400 of the profile fields: only the one that names
 * `reason` gets the words of the reason, and the rest keep the server's own.
 */
function motivoNoAdmitido(status: number, body: unknown): ApiError | undefined {
  if (status !== 400 || body === null || typeof body !== 'object') return undefined;
  const detalle = body as Record<string, unknown>;
  if (detalle.field !== 'reason') return undefined;
  return new ApiError(
    errorBody(body).message ?? 'la auditoría no admitió el motivo de esta escritura.',
    400,
    'invalid_reason',
  );
}

function contextoContaminado(status: number, body: unknown): ApiError | undefined {
  const detalle = errorBody(body);
  if (status !== 409 || detalle.error !== 'context_contaminated') return undefined;
  return new ContextoContaminadoError(
    detalle.message
      ?? 'los ficheros de gobierno de este alias contienen algo que no es suyo.',
    body,
  );
}

function entregaEnVuelo(status: number, body: unknown): ApiError | undefined {
  const detalle = errorBody(body);
  if (status !== 409 || detalle.error !== 'delivery_in_flight') return undefined;
  return new EntregaEnVueloError(
    detalle.message ?? 'hay una entrega en vuelo para este alias.',
    body,
  );
}

/** The whole refusal vocabulary of a governance write, in one place for both writing routes. */
function falloDeGobernanza(status: number, body: unknown): ApiError | undefined {
  return sesionSinPersona(status, body)
    ?? motivoNoAdmitido(status, body)
    ?? contextoContaminado(status, body)
    ?? entregaEnVuelo(status, body);
}

export function putAgentPerfil(
  request: RequestFn,
  tenantId: string,
  alias: string,
  profile: AgentPerfilValor,
  expectedRevision: number | null,
  reason: string,
): Promise<unknown> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`,
    {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: expectedRevision, profile, reason }),
    },
    { mapError: falloDeGobernanza },
  );
}

/**
 * Rewrites and re-measures the governance files of an alias from its stored revision. It does not
 * restart the harness and does not author anything, so it carries no expected revision: what it
 * carries is the person and the sentence they typed for it.
 */
export function postContextReload(
  request: RequestFn,
  tenantId: string,
  alias: string,
  reason: string,
): Promise<unknown> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/context/reload`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    },
    { mapError: falloDeGobernanza },
  );
}

function tramo(page: TramoDeRevisiones | undefined): string {
  const query = new URLSearchParams();
  if (page?.limit !== undefined) query.set('limit', String(page.limit));
  if (page?.cursor !== undefined) query.set('cursor', page.cursor);
  const texto = query.toString();
  return texto.length === 0 ? '' : `?${texto}`;
}

export function getProfileRevisions(
  request: RequestFn,
  tenantId: string,
  alias: string,
  page?: TramoDeRevisiones,
): Promise<PaginaDeRevisiones<PerfilRevision>> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil/revisions${tramo(page)}`,
  );
}

export function getDocumentRevisions(
  request: RequestFn,
  tenantId: string,
  alias: string,
  kind: AgentDocumentKind,
  page?: TramoDeRevisiones,
): Promise<PaginaDeRevisionesDeDocumento> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/revisions${tramo(page)}`,
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
  getAgentDocuments(tenantId: string, alias: string): Promise<AgentDocumentsMap>;
  getAgentDocumentContent(tenantId: string, alias: string, kind: AgentDocumentKind): Promise<AgentDocumentContent>;
  putAgentDocumentContent(
    tenantId: string,
    alias: string,
    kind: AgentDocumentKind,
    content: string,
    expectedSha: string | null,
    reason: string,
  ): Promise<AgentDocumentGuardado>;
  getAgentPerfil(tenantId: string, alias: string): Promise<AgentPerfil>;
  putAgentPerfil(
    tenantId: string,
    alias: string,
    profile: AgentPerfilValor,
    expectedRevision: number | null,
    reason: string,
  ): Promise<unknown>;
  postContextReload(tenantId: string, alias: string, reason: string): Promise<unknown>;
  getProfileRevisions(
    tenantId: string, alias: string, page?: TramoDeRevisiones,
  ): Promise<PaginaDeRevisiones<PerfilRevision>>;
  getDocumentRevisions(
    tenantId: string, alias: string, kind: AgentDocumentKind, page?: TramoDeRevisiones,
  ): Promise<PaginaDeRevisionesDeDocumento>;
  getTerminalCapability(): Promise<TerminalCapability>;
}

export function agentClient(request: RequestFn): AgentClient {
  return {
    getFleetActivity: () => getFleetActivity(request),
    getAgentDirective: (tenantId, alias) => getAgentDirective(request, tenantId, alias),
    getAgentDocuments: (tenantId, alias) => getAgentDocuments(request, tenantId, alias),
    getAgentDocumentContent: (tenantId, alias, kind) => getAgentDocumentContent(request, tenantId, alias, kind),
    putAgentDocumentContent: (tenantId, alias, kind, content, expectedSha, reason) =>
      putAgentDocumentContent(request, tenantId, alias, kind, content, expectedSha, reason),
    getAgentPerfil: (tenantId, alias) => getAgentPerfil(request, tenantId, alias),
    putAgentPerfil: (tenantId, alias, profile, expectedRevision, reason) =>
      putAgentPerfil(request, tenantId, alias, profile, expectedRevision, reason),
    postContextReload: (tenantId, alias, reason) =>
      postContextReload(request, tenantId, alias, reason),
    getProfileRevisions: (tenantId, alias, page) =>
      getProfileRevisions(request, tenantId, alias, page),
    getDocumentRevisions: (tenantId, alias, kind, page) =>
      getDocumentRevisions(request, tenantId, alias, kind, page),
    getTerminalCapability: () => getTerminalCapability(request),
  };
}

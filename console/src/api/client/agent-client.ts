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
import { spanishWithReason } from '../error-message';
import { ApiError, errorBody } from './core';
import type { RequestFn } from './system-client';
import type { ReconciliationApply } from '../../features/live/context-reconciliation';

async function getPublishedResource<T extends object>(
  load: () => Promise<T>,
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
        motivo: `El servidor todavía no ofrece este dato (respondió ${String(error.status)}).`,
      };
    }
    throw error;
  }
}

export function getFleetActivity(request: RequestFn): Promise<FleetActivitySnapshot> {
  return request('/v3/console/activity', { cache: 'no-store' });
}

export async function getAgentDirective(
  request: RequestFn,
  tenantId: string,
  alias: string,
): Promise<AgentDirective> {
  const ruta = `/v3/console/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/directive`;
  return getPublishedResource<Omit<AgentDirective, 'publicado' | 'motivo'>>(
    () => request<Omit<AgentDirective, 'publicado' | 'motivo'>>(ruta),
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
      'El servidor devolvió un contenido de documento incompleto o incoherente; no se mostrará como si el fichero estuviera vacío.',
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
    () => request<Omit<AgentPerfil, 'publicado' | 'motivo'>>(ruta, { cache: 'no-store' }, {
      mapError: perfilNoEncontrado,
    }),
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
    spanishWithReason(
      'Los documentos del agente contienen cambios fuera de su gobierno. Confirma qué contenido externo conservar antes de volver a guardar.',
      detalle.message ?? 'los ficheros de gobierno de este alias contienen algo que no es suyo.',
    ),
    body,
  );
}

function entregaEnVuelo(status: number, body: unknown): ApiError | undefined {
  const detalle = errorBody(body);
  if (status !== 409 || detalle.error !== 'delivery_in_flight') return undefined;
  return new EntregaEnVueloError(
    spanishWithReason(
      'Hay entregas en curso para este agente. Espera a que terminen y vuelve a medir.',
      detalle.message ?? 'hay una entrega en vuelo para este alias.',
    ),
    body,
  );
}

const CONTEXT_SOURCE_INVALID = 'La revisión del perfil Git no es válida o está incompleta. Elige otra revisión y vuelve a preparar el cambio.';

const GOVERNANCE_ERROR_TEXT: Readonly<Record<string, string>> = {
  agent_disabled: 'El agente está deshabilitado. Habilítalo desde la pestaña Ejecución de su ficha y vuelve a guardar el perfil.',
  profile_revision_conflict: 'El perfil cambió desde que se abrió. Actualízalo y vuelve a aplicar el borrador sobre la revisión vigente.',
  not_found: 'No se encontró el agente o ya no está visible. Actualiza el inventario y elige un agente disponible.',
  forbidden: 'Tu sesión ya no tiene permiso para esta operación. Entra con una persona autorizada o pide a un operador que revise el acceso.',
  scope_unavailable: 'La fuente Git ya no coincide con este perfil. Relee las fuentes del agente y selecciona una disponible.',
  confirmation_changed: 'La fuente del perfil cambió desde la vista previa. Relee la fuente y vuelve a confirmar antes de guardar.',
  invalid_confirmation: 'La confirmación de la fuente no es válida o venció. Vuelve a leerla y confirma de nuevo.',
  deleted_profile: 'El perfil de la fuente ya no existe. Elige una fuente o revisión disponible y prepara el cambio otra vez.',
  profile_absent: 'La revisión ya no contiene el perfil de este agente. Elige otra revisión donde exista y prepara el cambio otra vez.',
  repository_not_configured: 'Este agente no tiene una fuente Git configurada. Pide a un administrador que la configure o selecciona otra fuente.',
  invalid_repository_root: 'No se puede acceder a la ruta raíz de la fuente Git. Revisa su configuración con un administrador.',
  object_unavailable: 'No se pudo leer la revisión Git solicitada. Elige otra revisión disponible y prepara el cambio otra vez.',
  invalid_commit: CONTEXT_SOURCE_INVALID,
  unsupported_object_storage: 'El almacenamiento de la fuente Git no está disponible para esta operación. Revisa la fuente con un administrador.',
  missing_manifest: CONTEXT_SOURCE_INVALID,
  missing_file: 'Falta un archivo requerido en la revisión del perfil Git. Elige otra revisión y vuelve a preparar el cambio.',
  invalid_provenance: CONTEXT_SOURCE_INVALID,
  unsupported_harness: 'El tipo de agente de esta fuente no es compatible. Elige una fuente o revisión compatible y vuelve a prepararla.',
  unsupported_schema: 'La fuente usa una versión de esquema no compatible. Pide actualizar el conector antes de importar el perfil.',
  duplicate_agent: CONTEXT_SOURCE_INVALID,
  invalid_journal_id: CONTEXT_SOURCE_INVALID,
  invalid_revision: 'La revisión ya no coincide con el historial disponible. Actualiza el historial y elige otra revisión.',
  size_limit: 'La revisión supera el límite de lectura del perfil. Elige una revisión más pequeña y vuelve a prepararla.',
  invalid_path_policy: 'La política de rutas de la fuente no permite esta lectura. Revisa la configuración de la fuente con un administrador.',
  invalid_object: CONTEXT_SOURCE_INVALID,
  invalid_tree: CONTEXT_SOURCE_INVALID,
  unsupported_entry: CONTEXT_SOURCE_INVALID,
  invalid_blob: CONTEXT_SOURCE_INVALID,
  invalid_text: 'El perfil de la revisión no es texto válido. Corrige el archivo en Git o elige otra revisión.',
  invalid_schema: CONTEXT_SOURCE_INVALID,
  invalid_identifier: CONTEXT_SOURCE_INVALID,
  forbidden_content: 'El perfil contiene contenido que no se permite importar. Retira ese contenido en Git y vuelve a preparar el cambio.',
  invalid_json: CONTEXT_SOURCE_INVALID,
  duplicate_json_key: CONTEXT_SOURCE_INVALID,
  invalid_profile: CONTEXT_SOURCE_INVALID,
  context_source_unavailable: 'La fuente de contexto no respondió. Revisa su conexión y vuelve a intentarlo cuando esté disponible.',
  profile_write_unavailable: 'Esta instalación no puede preparar la escritura del perfil. Conserva el borrador y vuelve a intentarlo cuando el servicio esté disponible.',
  profile_write_unconfirmed: 'El servidor no confirmó el resultado de la escritura. Relee el perfil para comprobar qué revisión quedó activa antes de repetir el cambio.',
  profile_write_failed: 'No se pudo escribir el perfil. Conserva el borrador y relee el estado para comprobar el resultado antes de repetir el cambio.',
};

const RECONCILIATION_ERROR_TEXT: Readonly<Record<string, string>> = {
  context_write_not_applied: 'El lote de reconciliación no se aplicó. Relee el estado del contexto y vuelve a medir antes de reintentar.',
  agent_disabled: 'El agente está deshabilitado. Habilítalo desde la pestaña Ejecución de su ficha y vuelve a medir el contexto.',
  reconcile_snapshot_conflict: 'El perfil, la generación o los documentos cambiaron desde la medición. Relee el agente y crea una vista previa nueva antes de reconciliar.',
  runtime_ack_incomplete: 'El agente en ejecución no confirmó todos los documentos. Relee el perfil y las huellas; vuelve a medir antes de reintentar.',
  runtime_unverified: 'No se pudo verificar el entorno de este agente. Revisa la conexión de su ordenador y vuelve a medir.',
  runtime_expectation_absent: 'No hay un entorno del agente verificado para reconciliar. Actualiza el agente y confirma que esté habilitado.',
  profile_revision_conflict: 'El perfil cambió desde la lectura. Actualízalo y vuelve a medir antes de reconciliar.',
  runtime_generation_conflict: 'El entorno del agente cambió desde la lectura. Relee el agente y vuelve a medir antes de reconciliar.',
  document_set_conflict: 'La lista de documentos cambió desde la lectura. Actualiza el agente y vuelve a medir antes de reconciliar.',
  context_not_reconcilable: 'El contexto no se puede reconciliar en este estado. Revisa el perfil y el entorno del agente antes de intentarlo otra vez.',
  runtime_measurement_conflict: 'La medición del entorno del agente cambió. Relee el estado y vuelve a medir antes de reconciliar.',
  external_context_changed: 'El contenido externo cambió desde la medición. Relee los documentos y confirma otra vez qué conservarás.',
  context_not_drifted: 'El contexto ya no muestra la diferencia que se iba a reparar. Actualiza el agente para confirmar su estado.',
  context_reconcile_intent_not_recorded: 'No se registró la intención de auditoría y no se escribió nada. Espera a que la auditoría esté disponible y vuelve a medir.',
  context_reconcile_audit_failed: 'No se pudo registrar la auditoría y la acción se detuvo. Espera a que se recupere y vuelve a medir.',
  invalid_input: 'Los datos del agente o de la solicitud no son válidos. Actualiza el agente y revisa el motivo antes de medir.',
};

function errorDeCodigo(status: number, body: unknown, messages: Readonly<Record<string, string>>): ApiError | undefined {
  const detalle = errorBody(body);
  const code = detalle.error;
  const spanish = code === undefined ? undefined : messages[code];
  if (spanish === undefined || code === undefined) return undefined;
  return new ApiError(spanishWithReason(spanish, detalle.message), status, code);
}

function perfilNoEncontrado(status: number, body: unknown): ApiError | undefined {
  if (status !== 404) return undefined;
  return errorDeCodigo(status, body, { not_found: GOVERNANCE_ERROR_TEXT.not_found });
}

function falloDeContexto(status: number, body: unknown): ApiError | undefined {
  return sesionSinPersona(status, body)
    ?? motivoNoAdmitido(status, body)
    ?? contextoContaminado(status, body)
    ?? entregaEnVuelo(status, body);
}

/** The whole refusal vocabulary of a governance write, in one place for both writing routes. */
function falloDeGobernanza(status: number, body: unknown): ApiError | undefined {
  return falloDeContexto(status, body) ?? errorDeCodigo(status, body, GOVERNANCE_ERROR_TEXT);
}

function falloDeReconciliacion(status: number, body: unknown): ApiError | undefined {
  return falloDeContexto(status, body)
    ?? errorDeCodigo(status, body, RECONCILIATION_ERROR_TEXT)
    ?? errorDeCodigo(status, body, GOVERNANCE_ERROR_TEXT);
}

export function putAgentPerfil(
  request: RequestFn,
  tenantId: string,
  alias: string,
  profile: AgentPerfilValor,
  expectedRevision: number | null,
  reason: string,
  contextSource?: unknown,
): Promise<unknown> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`,
    {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: expectedRevision, profile, reason,
        ...(contextSource === undefined ? {} : { context_source: contextSource }) }),
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

function postContextReconciliation(
  request: RequestFn, tenantId: string, alias: string,
  phase: 'preview' | 'apply', body: { readonly reason: string } | ReconciliationApply,
): Promise<unknown> {
  return request(
    `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/context/reconcile/${phase}`,
    { method: 'POST', body: JSON.stringify(body) },
    { mapError: falloDeReconciliacion },
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
      return { available: false, reason: 'El servicio de terminales no está habilitado. Pide a un administrador que lo active para esta instalación.' };
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
  previewContextReconciliation(tenantId: string, alias: string, reason: string): Promise<unknown>;
  applyContextReconciliation(tenantId: string, alias: string, body: ReconciliationApply): Promise<unknown>;
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
    previewContextReconciliation: (tenantId, alias, reason) =>
      postContextReconciliation(request, tenantId, alias, 'preview', { reason }),
    applyContextReconciliation: (tenantId, alias, body) =>
      postContextReconciliation(request, tenantId, alias, 'apply', body),
    getProfileRevisions: (tenantId, alias, page) =>
      getProfileRevisions(request, tenantId, alias, page),
    getDocumentRevisions: (tenantId, alias, kind, page) =>
      getDocumentRevisions(request, tenantId, alias, kind, page),
    getTerminalCapability: () => getTerminalCapability(request),
  };
}

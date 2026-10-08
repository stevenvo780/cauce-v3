import type { ClientConnectionsPage, ClientDeclarationResult, ClientDeclarationRequest,
  CreateClientDeclaration, RenameClientDeclaration } from '../types/client-delegations';
import type { RequestFn } from './system-client';

export interface ClientDelegationsClient {
  listClientConnections(): Promise<ClientConnectionsPage>;
  createClientDeclaration(input: CreateClientDeclaration): Promise<ClientDeclarationResult>;
  renameClientDeclaration(bindingId: string, input: RenameClientDeclaration): Promise<ClientDeclarationResult>;
  revokeClientDeclaration(bindingId: string, input: ClientDeclarationRequest): Promise<ClientDeclarationResult>;
}

// Browser validators mirror the Node-only protocol schemas; tests check parity.
export function clientDeclarationUuid(value: string): string {
  if (value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('Invalid declaration UUID');
  }
  return value;
}

export function clientDeclarationReference(value: string): string {
  if (value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('Invalid connection reference');
  return value;
}

export function clientDeclarationLabel(value: string): string {
  if (!value.length || value.length > 128 || /[^A-Za-z0-9 ._-]/u.test(value)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/u.test(value)) throw new Error('Invalid declaration label');
  return value;
}

export class ClientDeclarationResponseError extends Error {
  constructor() { super('La respuesta del servidor no confirma esta declaración. Recargá las conexiones.'); }
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientDeclarationResponseError();
  return value as Record<string, unknown>;
}

export function clientDeclarationResponse(value: unknown): ClientDeclarationResult {
  const result = responseObject(value);
  if (typeof result.binding_id !== 'string' || typeof result.connection_ref !== 'string'
    || typeof result.owner_human_id !== 'string' || result.owner_human_id.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result.owner_human_id)
    || typeof result.owner_tenant_id !== 'string' || result.owner_tenant_id.length > 64
    || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(result.owner_tenant_id)
    || typeof result.label !== 'string' || typeof result.display_label !== 'string'
    || !result.display_label.startsWith(`${result.label} por cuenta de `)
    || result.basis !== 'owner_declared_grant' || result.instance !== 'unknown' || typeof result.revoked !== 'boolean') {
    throw new ClientDeclarationResponseError();
  }
  try { clientDeclarationUuid(result.binding_id); clientDeclarationReference(result.connection_ref); clientDeclarationLabel(result.label); }
  catch { throw new ClientDeclarationResponseError(); }
  return result as unknown as ClientDeclarationResult;
}

function validMailbox(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const mailbox = responseObject(value);
  return typeof mailbox.tenant_id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(mailbox.tenant_id)
    && typeof mailbox.alias === 'string' && /^mbx-[a-f0-9]{48}$/u.test(mailbox.alias);
}

export function clientConnectionsResponse(value: unknown): ClientConnectionsPage {
  const page = responseObject(value);
  if (!Array.isArray(page.items) || page.items.length > 100 || typeof page.truncated !== 'boolean') throw new ClientDeclarationResponseError();
  for (const value of page.items as unknown[]) {
    const row = responseObject(value);
    if (typeof row.connection_ref !== 'string' || typeof row.client_id !== 'string' || !row.client_id
      || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
      || typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))
      || typeof row.revoked !== 'boolean' || (row.binding_id !== null && typeof row.binding_id !== 'string')
      || (row.label !== null && typeof row.label !== 'string') || (row.display_label !== null && typeof row.display_label !== 'string')
      || (row.last_publication_at !== null && (typeof row.last_publication_at !== 'string' || !Number.isFinite(Date.parse(row.last_publication_at))))
      || row.basis !== 'owner_declared_grant' || row.instance !== 'unknown' || row.last_use_at !== null || row.last_use_observed !== false
      || !validMailbox(row.mailbox)) {
      throw new ClientDeclarationResponseError();
    }
    try {
      clientDeclarationReference(row.connection_ref);
      if (typeof row.binding_id === 'string') clientDeclarationUuid(row.binding_id);
      if (typeof row.label === 'string') clientDeclarationLabel(row.label);
    } catch { throw new ClientDeclarationResponseError(); }
  }
  return page as unknown as ClientConnectionsPage;
}

export function clientDelegationsClient(request: RequestFn): ClientDelegationsClient {
  return {
    listClientConnections: () => request<unknown>('/v3/console/mcp/client-delegations', { cache: 'no-store' }).then(clientConnectionsResponse),
    createClientDeclaration: (input) => request('/v3/console/mcp/client-delegations', { method: 'POST',
      body: JSON.stringify({ request_id: clientDeclarationUuid(input.request_id),
        connection_ref: clientDeclarationReference(input.connection_ref), label: clientDeclarationLabel(input.label) }) }).then(clientDeclarationResponse),
    renameClientDeclaration: (bindingId, input) => request(`/v3/console/mcp/client-delegations/${clientDeclarationUuid(bindingId)}/rename`, {
      method: 'POST', body: JSON.stringify({ request_id: clientDeclarationUuid(input.request_id), label: clientDeclarationLabel(input.label) }) }).then(clientDeclarationResponse),
    revokeClientDeclaration: (bindingId, input) => request(`/v3/console/mcp/client-delegations/${clientDeclarationUuid(bindingId)}/revoke`, {
      method: 'POST', body: JSON.stringify({ request_id: clientDeclarationUuid(input.request_id) }) }).then(clientDeclarationResponse),
  };
}

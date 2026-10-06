import { ApiError } from '../../api/client/core';
import { clientDeclarationUuid, clientDeclarationReference, clientDeclarationLabel, clientDeclarationResponse, ClientDeclarationResponseError,
  type ClientDelegationsClient } from '../../api/client/client-delegations-client';
import type { ClientConnection, ClientConnectionsPage, ClientDeclarationRequest,
  CreateClientDeclaration, RenameClientDeclaration } from '../../api/types/client-delegations';

export type ClientDeclarationCommand =
  | { operation: 'create'; input: Readonly<CreateClientDeclaration> }
  | { operation: 'rename'; bindingId: string; connectionRef: string; input: Readonly<RenameClientDeclaration> }
  | { operation: 'revoke'; bindingId: string; connectionRef: string; expectedLabel: string; input: Readonly<ClientDeclarationRequest> };

export function selectedConnection(page: ClientConnectionsPage | undefined, reference: string): ClientConnection | undefined {
  const matches = page?.items.filter(item => item.connection_ref === reference) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function verifiedConnection(page: ClientConnectionsPage | undefined, reference: string): ClientConnection {
  try { clientDeclarationReference(reference); } catch { throw new Error('La connection_ref debe ser exactamente 64 caracteres hexadecimales en minúsculas.'); }
  if (!page) throw new Error('Recargá la lista antes de verificar la referencia.');
  const matches = page.items.filter(item => item.connection_ref === reference);
  if (matches.length > 1) throw new Error('La referencia es ambigua en la lista actual. No se seleccionó ninguna conexión.');
  if (!matches.length) throw new Error(page.truncated
    ? 'La referencia no está entre las 100 conexiones visibles de esta lista truncada. No se seleccionó otra conexión.'
    : 'La referencia no se encontró en la lista actual. No se seleccionó otra conexión.');
  return matches[0];
}

export function confirmDeclarationResult(command: ClientDeclarationCommand, value: unknown) {
  const result = clientDeclarationResponse(value);
  const reference = command.operation === 'create' ? command.input.connection_ref : command.connectionRef;
  const label = command.operation === 'revoke' ? command.expectedLabel : command.input.label;
  if (result.connection_ref !== reference || result.label !== label || result.revoked !== (command.operation === 'revoke')
    || (command.operation === 'revoke' && result.binding_id !== command.bindingId)
    || (command.operation === 'rename' && result.binding_id === command.bindingId)) throw new ClientDeclarationResponseError();
  return result;
}

export function grantActive(connection: ClientConnection, now = Date.now()): boolean {
  const expiry = Date.parse(connection.expires_at);
  return !connection.revoked && Number.isFinite(expiry) && expiry > now;
}

export function prepareDeclaration(operation: ClientDeclarationCommand['operation'], connection: ClientConnection | undefined,
  label: string, requestId: string): ClientDeclarationCommand {
  if (!connection) throw new Error('Elegí una referencia exacta de la lista actual.');
  clientDeclarationUuid(requestId);
  if (operation !== 'revoke' && !grantActive(connection)) throw new Error('El grant venció o fue revocado. Recargá las conexiones.');
  const input = { request_id: requestId };
  if (operation === 'create') {
    if (connection.binding_id !== null) throw new Error('La conexión ya tiene una declaración. Recargá la lista.');
    return Object.freeze({ operation, input: Object.freeze({ ...input,
      connection_ref: clientDeclarationReference(connection.connection_ref), label: clientDeclarationLabel(label) }) });
  }
  if (!connection.binding_id) throw new Error('Missing declaration binding');
  const bindingId = clientDeclarationUuid(connection.binding_id);
  const connectionRef = clientDeclarationReference(connection.connection_ref);
  return operation === 'rename'
    ? Object.freeze({ operation, bindingId, connectionRef, input: Object.freeze({ ...input, label: clientDeclarationLabel(label) }) })
    : Object.freeze({ operation, bindingId, connectionRef, expectedLabel: clientDeclarationLabel(connection.label ?? ''), input: Object.freeze(input) });
}

export function sendDeclaration(api: ClientDelegationsClient, command: ClientDeclarationCommand) {
  switch (command.operation) {
    case 'create': return api.createClientDeclaration(command.input);
    case 'rename': return api.renameClientDeclaration(command.bindingId, command.input);
    case 'revoke': return api.revokeClientDeclaration(command.bindingId, command.input);
  }
}

export function uncertainDeclaration(cause: unknown): boolean {
  return !(cause instanceof ApiError) || cause.status >= 500 || cause.status === 408 || cause.status === 429;
}

export function declarationError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return 'La sesión venció. Volvé a iniciar sesión.';
    if (cause.status === 403) return 'El servidor no autoriza esta declaración para la cuenta actual.';
    if (cause.status === 404) return 'La conexión o esta función no está disponible. Recargá la lista; no se elegirá otra conexión.';
    if (cause.status === 409) return 'La declaración cambió. Recargá y revisá la conexión antes de una nueva acción.';
  }
  return cause instanceof Error ? cause.message : 'No se pudo confirmar la operación.';
}

export interface ClientConnection {
  connection_ref: string;
  client_id: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  binding_id: string | null;
  label: string | null;
  display_label: string | null;
  basis: 'owner_declared_grant';
  instance: 'unknown';
  last_publication_at: string | null;
  last_use_at: null;
  last_use_observed: false;
  /** Address of the client's mailbox while the declaration is active; older gateways omit it. */
  mailbox?: { tenant_id: string; alias: string } | null;
}

export interface ClientConnectionsPage { items: ClientConnection[]; truncated: boolean }
export interface ClientDeclarationRequest { request_id: string }
export interface CreateClientDeclaration extends ClientDeclarationRequest { connection_ref: string; label: string }
export interface RenameClientDeclaration extends ClientDeclarationRequest { label: string }
export interface ClientDeclarationResult {
  binding_id: string;
  connection_ref: string;
  owner_human_id: string;
  owner_tenant_id: string;
  label: string;
  display_label: string;
  basis: 'owner_declared_grant';
  instance: 'unknown';
  revoked: boolean;
}

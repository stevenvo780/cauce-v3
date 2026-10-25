import type { RequestFn } from './system-client';

export type TerminalGrantMode = 'shell' | 'harness' | 'harness_rw';

export interface TerminalGrant {
  id: string; company_id: string; tenant_id: string; alias: string;
  grantee_human_id: string; grantee_email: string; grantee_display_name: string;
  modes: TerminalGrantMode[]; expires_at: string | null; expired: boolean;
  note: string | null; granted_by_human_id: string;
  created_at: string; updated_at: string; version: number;
}

export interface TerminalGrantInventory {
  company_id: string; items: TerminalGrant[];
  capabilities: { create: boolean; update: boolean; revoke: boolean };
}

export interface TerminalGrantCreateInput {
  tenant_id: string; alias: string; grantee_human_id: string;
  modes: TerminalGrantMode[]; expires_at?: string | null; note?: string | null;
}

export interface TerminalGrantUpdateInput {
  expected_version: number; modes?: TerminalGrantMode[];
  expires_at?: string | null; note?: string | null;
}

export interface TerminalGrantsClient {
  listTerminalGrants(): Promise<TerminalGrantInventory>;
  createTerminalGrant(input: TerminalGrantCreateInput): Promise<TerminalGrant>;
  updateTerminalGrant(id: string, input: TerminalGrantUpdateInput): Promise<TerminalGrant>;
  revokeTerminalGrant(id: string, expectedVersion: number): Promise<TerminalGrant>;
}

const GRANT_KEYS = ['id', 'company_id', 'tenant_id', 'alias', 'grantee_human_id', 'grantee_email',
  'grantee_display_name', 'modes', 'expires_at', 'expired', 'note', 'granted_by_human_id',
  'created_at', 'updated_at', 'version'];
const MODES: readonly string[] = ['shell', 'harness', 'harness_rw'];

function invalid(): never { throw new Error('El servidor no acreditó las concesiones de terminal. Relee antes de continuar.'); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function grant(value: unknown): TerminalGrant {
  const row = record(value);
  if (Object.keys(row).length !== GRANT_KEYS.length || Object.keys(row).some((key) => !GRANT_KEYS.includes(key))) invalid();
  if (typeof row.id !== 'string' || typeof row.company_id !== 'string' || typeof row.tenant_id !== 'string'
    || typeof row.alias !== 'string' || typeof row.grantee_human_id !== 'string'
    || typeof row.grantee_email !== 'string' || typeof row.grantee_display_name !== 'string'
    || !Array.isArray(row.modes) || row.modes.some((mode) => typeof mode !== 'string' || !MODES.includes(mode))
    || !(row.expires_at === null || typeof row.expires_at === 'string') || typeof row.expired !== 'boolean'
    || !(row.note === null || typeof row.note === 'string') || typeof row.granted_by_human_id !== 'string'
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) invalid();
  return row as unknown as TerminalGrant;
}

function inventory(value: unknown): TerminalGrantInventory {
  const body = record(value);
  const capabilities = record(body.capabilities);
  if (typeof body.company_id !== 'string' || !Array.isArray(body.items)
    || typeof capabilities.create !== 'boolean' || typeof capabilities.update !== 'boolean'
    || typeof capabilities.revoke !== 'boolean') invalid();
  return { company_id: body.company_id, items: body.items.map(grant), capabilities: capabilities as unknown as TerminalGrantInventory['capabilities'] };
}

export function terminalGrantsClient(request: RequestFn): TerminalGrantsClient {
  const base = '/v3/console/terminal/grants';
  return {
    listTerminalGrants: async () => inventory(await request(base, { cache: 'no-store' })),
    createTerminalGrant: async (input) => grant(await request(base, {
      method: 'POST', body: JSON.stringify(input), cache: 'no-store',
    })),
    updateTerminalGrant: async (id, input) => grant(await request(`${base}/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input), cache: 'no-store',
    })),
    revokeTerminalGrant: async (id, expectedVersion) => grant(await request(
      `${base}/${encodeURIComponent(id)}?expected_version=${String(expectedVersion)}`,
      { method: 'DELETE', cache: 'no-store' },
    )),
  };
}

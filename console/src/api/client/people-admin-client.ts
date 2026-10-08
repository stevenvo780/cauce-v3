import { ApiError } from './core';
import type { RequestFn } from './system-client';

export interface ManagedPerson {
  id: string; email: string; display_name: string; role: 'operator' | 'reader';
  tenant_id: string; alias: string; active: boolean; revision: string;
}
export interface PeopleCapabilities { create: boolean; update: boolean; retire: boolean; restore: boolean; purge: boolean }
export interface PeopleInventory { items: ManagedPerson[]; capabilities: PeopleCapabilities }
export interface PersonValues {
  email: string; display_name: string; role: ManagedPerson['role']; tenant_id: string; alias: string; active: boolean; password: string;
}
export type PersonPatch = Partial<PersonValues>;
export interface PeopleAdminClient {
  listPeople(): Promise<PeopleInventory>;
  createPerson(input: PersonValues): Promise<ManagedPerson>;
  updatePerson(id: string, expectedRevision: string, patch: PersonPatch): Promise<ManagedPerson>;
  retirePerson(id: string, expectedRevision: string): Promise<ManagedPerson>;
  restorePerson(id: string, expectedRevision: string): Promise<ManagedPerson>;
  purgePerson(id: string, expectedRevision: string): Promise<{ id: string; revision: string; purged: true }>;
}
const ROW_KEYS = ['id', 'email', 'display_name', 'role', 'tenant_id', 'alias', 'active', 'revision'];
const CAPABILITY_KEYS = ['create', 'update', 'retire', 'restore', 'purge'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function invalid(): never { throw new Error('El servidor no acreditó el inventario de personas. Relee antes de continuar.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/u.test(value)) invalid();
}
function identity(value: string) { if (!UUID.test(value)) invalid(); return encodeURIComponent(value); }
function values(input: PersonPatch, create = false): PersonPatch {
  const row = record(input);
  const keys = ['email', 'display_name', 'role', 'tenant_id', 'alias', 'active', 'password'];
  if (Object.keys(row).some(key => !keys.includes(key)) || (create && keys.some(key => !Object.hasOwn(row, key)))) invalid();
  if (row.email !== undefined && (typeof row.email !== 'string' || row.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.email))
      || row.display_name !== undefined && (typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.trim().length > 120)
      || row.role !== undefined && (typeof row.role !== 'string' || !['operator', 'reader'].includes(row.role))
      || row.tenant_id !== undefined && (typeof row.tenant_id !== 'string' || !row.tenant_id.length)
      || row.alias !== undefined && (typeof row.alias !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(row.alias))
      || row.active !== undefined && typeof row.active !== 'boolean'
      || row.password !== undefined && (typeof row.password !== 'string' || row.password.length < 12 || row.password.length > 1024)) invalid();
  return row;
}
function person(value: unknown, expectedId?: string, expectedRevision?: string): ManagedPerson {
  const row = record(value); exact(row, ROW_KEYS);
  if (typeof row.id !== 'string' || !UUID.test(row.id) || (expectedId !== undefined && row.id !== expectedId)
      || typeof row.active !== 'boolean' || typeof row.role !== 'string' || !['operator', 'reader'].includes(row.role)) invalid();
  for (const key of ['email', 'display_name', 'tenant_id', 'alias']) {
    if (typeof row[key] !== 'string' || !row[key].length) invalid();
  }
  revision(row.revision);
  if (expectedRevision !== undefined && BigInt(row.revision) <= BigInt(expectedRevision)) invalid();
  return row as unknown as ManagedPerson;
}
function confirmed(row: ManagedPerson, patch: PersonPatch): ManagedPerson {
  for (const key of ['email', 'display_name', 'role', 'tenant_id', 'alias', 'active'] as const) {
    if (patch[key] === undefined) continue;
    const expected = key === 'email' ? patch[key].trim().toLowerCase()
      : key === 'display_name' ? patch[key].trim() : patch[key];
    if (row[key] !== expected) invalid();
  }
  return row;
}
function safeError(status: number): ApiError {
  const message = status === 409 ? 'La revisión cambió o existe una dependencia protegida. Relee el inventario; el último administrador debe conservar acceso.'
    : status === 403 ? 'Esta cuenta no tiene autoridad para administrar personas.'
    : status === 404 ? 'La persona o la administración no está disponible. Relee el inventario.'
    : status === 400 ? 'Revisa los datos de la persona y su contraseña.'
    : 'No se confirmó el cambio de persona. Relee el inventario antes de reintentar.';
  return new ApiError(message, status, 'people_administration_failed');
}
export function peopleAdminClient(request: RequestFn): PeopleAdminClient {
  const path = '/v3/console/people';
  const options = { requireCsrf: true, mapError: (status: number) => safeError(status) };
  async function mutate(id: string, expectedRevision: string, method: string, suffix = '', patch?: PersonPatch) {
    revision(expectedRevision);
    const result = await request(`${path}/${identity(id)}${suffix}`, { method, cache: 'no-store',
      body: JSON.stringify({ expected_revision: expectedRevision, ...(patch ? values(patch) : {}) }) }, options);
    const row = person(result, id, expectedRevision);
    return patch ? confirmed(row, patch) : row;
  }
  return {
    listPeople: async () => {
      const result = record(await request(path, { cache: 'no-store' }, options)); exact(result, ['items', 'capabilities']);
      if (!Array.isArray(result.items)) invalid();
      const capability = record(result.capabilities); exact(capability, CAPABILITY_KEYS);
      if (CAPABILITY_KEYS.some(key => typeof capability[key] !== 'boolean')) invalid();
      const items = result.items.map(value => person(value));
      if (new Set(items.map(value => value.id)).size !== items.length) invalid();
      return { items, capabilities: capability as unknown as PeopleCapabilities };
    },
    createPerson: async input => confirmed(person(await request(path, { method: 'POST', body: JSON.stringify(values(input, true)), cache: 'no-store' }, options)), input),
    updatePerson: (id, expected, patch) => mutate(id, expected, 'PATCH', '', patch),
    retirePerson: async (id, expected) => {
      const result = await mutate(id, expected, 'DELETE'); if (result.active) invalid(); return result;
    },
    restorePerson: async (id, expected) => {
      const result = await mutate(id, expected, 'POST', '/restore'); if (!result.active) invalid(); return result;
    },
    purgePerson: async (id, expected) => {
      revision(expected);
      const result = record(await request(`${path}/${identity(id)}/purge`, { method: 'DELETE', cache: 'no-store',
        body: JSON.stringify({ expected_revision: expected }) }, options)); exact(result, ['id', 'revision', 'purged']);
      revision(result.revision);
      if (result.id !== id || result.purged !== true || result.revision !== expected) invalid();
      return { id, revision: result.revision, purged: true };
    },
  };
}

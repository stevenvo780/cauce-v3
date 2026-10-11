import { z } from 'zod';
import { TenantSchema } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';

const Coordinate = z.number().min(-100_000).max(100_000);
const Size = z.number().positive().max(100_000);
const Part = z.object({ id: z.string().min(1).max(128), label: z.string().trim().min(1).max(120),
  x: Coordinate, y: Coordinate, width: Size, height: Size }).strict();
const Room = z.object({ tenant_id: TenantSchema, room_id: z.string().min(1).max(128),
  x: Coordinate, y: Coordinate, width: Size, height: Size, parts: z.array(Part).max(100) }).strict()
  .refine(room => new Set(room.parts.map(part => part.id)).size === room.parts.length, 'duplicate room part');
const Rooms = z.array(Room).max(500).refine(rooms =>
  new Set(rooms.map(room => JSON.stringify([room.tenant_id, room.room_id]))).size === rooms.length, 'duplicate office room');
export const CompanyOfficeUpdateSchema = z.object({ expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), rooms: Rooms }).strict();
export type CompanyOfficeRoom = z.infer<typeof Room>;
export interface CompanyOfficeLayout { company_id: string; version: number; rooms: CompanyOfficeRoom[] }

function wide(authority: CompanyAuthority): boolean { return authority.scope === 'company' || authority.scope === 'platform'; }
function authorize(authority: CompanyAuthority, write: boolean): void {
  if (authority.humanId === null || authority.role === 'none' || (write && !wide(authority))) {
    throw new StoreError('forbidden', 'company office authority is required');
  }
}
async function availableRooms(client: DatabaseClient, authority: CompanyAuthority): Promise<Set<string>> {
  const rows = await client.query<{ tenant_id: string; id: string }>(
    `SELECT room.tenant_id,room.id FROM rooms room JOIN tenants tenant ON tenant.id=room.tenant_id
     WHERE tenant.company_id=$1 AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
       AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
       AND ($2::text IS NULL OR room.tenant_id=$2) FOR SHARE OF room,tenant`,
    [authority.actingCompany, wide(authority) ? null : authority.homeTenant]);
  return new Set(rows.rows.map(room => JSON.stringify([room.tenant_id, room.id])));
}
async function readLayout(client: DatabaseClient, authority: CompanyAuthority): Promise<CompanyOfficeLayout> {
  const row = (await client.query<{ rooms: unknown; version: string }>(
    'SELECT rooms,version::text FROM company_office_layouts WHERE company_id=$1', [authority.actingCompany])).rows[0];
  const available = await availableRooms(client, authority);
  return { company_id: authority.actingCompany, version: Number(row?.version ?? 0),
    rooms: Rooms.parse(row?.rooms ?? []).filter(room => available.has(JSON.stringify([room.tenant_id, room.room_id]))) };
}
export async function readCompanyOffice(pool: DatabasePool, source: CompanyAuthoritySource): Promise<CompanyOfficeLayout> {
  return withTransaction(pool, async client => {
    const authority = await source(client); authorize(authority, false); return readLayout(client, authority);
  });
}
export async function writeCompanyOffice(pool: DatabasePool, source: CompanyAuthoritySource, value: unknown): Promise<CompanyOfficeLayout> {
  const input = CompanyOfficeUpdateSchema.parse(value);
  return withTransaction(pool, async client => {
    const authority = await source(client); authorize(authority, true);
    await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_056, authority.actingCompany]);
    const available = await availableRooms(client, authority);
    if (input.rooms.some(room => !available.has(JSON.stringify([room.tenant_id, room.room_id])))) {
      throw new StoreError('forbidden', 'office room is unavailable in the acting company');
    }
    const written = input.expected_version === 0
      ? await client.query(`INSERT INTO company_office_layouts(company_id,rooms,updated_by) VALUES($1,$2::jsonb,$3)
          ON CONFLICT (company_id) DO NOTHING RETURNING version`, [authority.actingCompany, JSON.stringify(input.rooms), authority.humanId])
      : await client.query(`UPDATE company_office_layouts SET rooms=$2::jsonb,updated_by=$3,version=version+1,updated_at=now()
          WHERE company_id=$1 AND version=$4 RETURNING version`,
        [authority.actingCompany, JSON.stringify(input.rooms), authority.humanId, input.expected_version]);
    if (!written.rowCount) throw new StoreError('conflict', 'office layout version changed; reload and retry');
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
      VALUES($1,$2,'office.layout.update','allow',$3,$4,$5::jsonb)`, [authority.homeTenant, authority.alias,
      authority.actingCompany, authority.humanId, JSON.stringify({ expected_version: input.expected_version })]);
    return readLayout(client, authority);
  });
}

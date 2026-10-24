import type { DatabaseClient } from './db.js';

export async function removeCompanyOfficeRooms(client: DatabaseClient, tenant: string, room: string | null = null): Promise<void> {
  // Row updates share the layout CAS without taking its advisory lock after room locks.
  await client.query(`UPDATE company_office_layouts layout SET rooms=(
      SELECT COALESCE(jsonb_agg(entry.room ORDER BY entry.position),'[]'::jsonb)
      FROM jsonb_array_elements(layout.rooms) WITH ORDINALITY AS entry(room,position)
      WHERE NOT (entry.room->>'tenant_id'=$1 AND ($2::text IS NULL OR entry.room->>'room_id'=$2))
    ),version=version+1,updated_at=clock_timestamp()
    WHERE layout.company_id=(SELECT company_id FROM tenants WHERE id=$1)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(layout.rooms) entry
        WHERE entry->>'tenant_id'=$1 AND ($2::text IS NULL OR entry->>'room_id'=$2))`, [tenant, room]);
}

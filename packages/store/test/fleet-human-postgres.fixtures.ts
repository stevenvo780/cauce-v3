import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../src/index.js';

/**
 * The verified console person behind a fleet actor, `admin` of the tenant's company unless another role
 * is given: company fleet authority comes from such a person, never from the hub. Returns its subject.
 */
export async function seedFleetHuman(
  pool: DatabasePool, tenant: string, alias: string, role: 'owner' | 'admin' | null = 'admin',
): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fleet operator','operator',$4,$5)`, [id, `${id}@example.test`, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,$2,$3,ARRAY['read','control'])`, [id, tenant, alias]);
  if (role !== null) {
    await pool.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      SELECT company_id,$1,$2,'platform',$1 FROM tenants WHERE id=$3`, [id, role, tenant]);
  }
  return `console:${id}`;
}

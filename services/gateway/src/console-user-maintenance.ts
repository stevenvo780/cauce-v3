import { withTransaction, type DatabasePool } from '@cauce/store';
import { consoleRoleAuthority } from './console-user-authority.js';
import { normalizeEmail, type ConsoleUserRole } from './console-users.js';

export interface ConsoleUserMaintenance {
  email: string;
  name: string | undefined;
  role: ConsoleUserRole | undefined;
  tenant: string | undefined;
  alias: string | undefined;
  updateOnly: boolean;
  activate: boolean;
}

export interface MaintainedConsoleUser {
  id: string;
  role: ConsoleUserRole;
  tenant_id: string;
  alias: string;
  active: boolean;
}

export async function maintainConsoleUser(
  pool: DatabasePool,
  options: ConsoleUserMaintenance,
  passwordHash: string,
): Promise<MaintainedConsoleUser> {
  const assignments = `password_hash=$2,
    display_name=COALESCE($3,console_users.display_name),
    role=COALESCE($4,console_users.role),
    tenant_id=COALESCE($5,console_users.tenant_id),
    alias=COALESCE($6,console_users.alias),
    active=COALESCE($7,console_users.active),
    password_changed_at=CURRENT_TIMESTAMP,
    updated_at=CURRENT_TIMESTAMP`;
  const values = [normalizeEmail(options.email), passwordHash,
    options.name ?? null, options.role ?? null, options.tenant ?? null, options.alias ?? null,
    options.activate ? true : null];
  if (options.updateOnly) {
    const result = await pool.query<MaintainedConsoleUser>(
      `UPDATE console_users SET ${assignments} WHERE email_normalized=$1
       RETURNING id, role, tenant_id, alias, active`, values,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no existe una cuenta de consola para ${options.email}`);
    return row;
  }

  return withTransaction(pool, async (client) => {
    const inserted = await client.query<MaintainedConsoleUser>(
      `INSERT INTO console_users
       (email, email_normalized, password_hash, display_name, role, tenant_id, alias, active)
       VALUES ($8,$1,$2,COALESCE($3,split_part($8,'@',1)),COALESCE($4,'operator'),
         COALESCE($5,'Steven'),COALESCE($6,'kant'),COALESCE($7,true))
       ON CONFLICT (email_normalized) DO NOTHING
       RETURNING id, role, tenant_id, alias, active`,
      [...values, options.email],
    );
    let row = inserted.rows[0];
    if (row !== undefined) {
      const authority = consoleRoleAuthority(row.role);
      await client.query(
        `INSERT INTO human_tenant_memberships
          (human_id,tenant_id,actor_alias,role,permissions,enabled,revoked_at)
         VALUES ($1,$2,$3,$4,$5,true,NULL)`,
        [row.id, row.tenant_id, row.alias, row.role, [...authority.permissions]],
      );
    } else {
      const updated = await client.query<MaintainedConsoleUser>(
        `UPDATE console_users SET ${assignments} WHERE email_normalized=$1
         RETURNING id, role, tenant_id, alias, active`, values,
      );
      row = updated.rows[0];
      if (row === undefined) throw new Error(`no existe una cuenta de consola para ${options.email}`);
    }
    return row;
  });
}

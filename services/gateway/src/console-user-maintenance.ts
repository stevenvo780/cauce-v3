import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
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

interface MaintainedConsoleUser {
  id: string;
  role: ConsoleUserRole;
  tenant_id: string;
  alias: string;
  active: boolean;
}

/** A new account names its tenant and alias: there is no default identity. */
export function assertProvisionTarget(options: Pick<ConsoleUserMaintenance, 'tenant' | 'alias' | 'updateOnly'>): void {
  if (!options.updateOnly && (options.tenant === undefined || options.alias === undefined)) {
    throw new Error('--tenant y --alias son obligatorios para guardar una cuenta (sin --update)');
  }
}

/** A person never changes company: the tenant it is placed in must belong to its own company. */
async function assertSameCompany(client: Pick<DatabaseClient, 'query'>, email: string, tenant: string | undefined): Promise<void> {
  if (tenant === undefined) return;
  const row = (await client.query<{ same: boolean }>(
    `SELECT person.company_id=target.company_id AS same FROM console_users person, tenants target
      WHERE person.email_normalized=$1 AND target.id=$2`, [email, tenant])).rows[0];
  if (row !== undefined && !row.same) throw new Error('una cuenta no cambia de empresa: el tenant pertenece a otra');
}

export async function maintainConsoleUser(
  pool: DatabasePool,
  options: ConsoleUserMaintenance,
  passwordHash: string,
): Promise<MaintainedConsoleUser> {
  assertProvisionTarget(options);
  const assignments = `password_hash=$2,
    display_name=COALESCE($3,console_users.display_name),
    role=COALESCE($4,console_users.role),
    tenant_id=COALESCE($5,console_users.tenant_id),
    alias=COALESCE($6,console_users.alias),
    active=COALESCE($7,console_users.active),
    password_changed_at=CURRENT_TIMESTAMP,
    updated_at=CURRENT_TIMESTAMP`;
  const email = normalizeEmail(options.email);
  const values = [email, passwordHash,
    options.name ?? null, options.role ?? null, options.tenant ?? null, options.alias ?? null,
    options.activate ? true : null];
  if (options.updateOnly) {
    await assertSameCompany(pool, email, options.tenant);
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
         $5,$6,COALESCE($7,true))
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
      await assertSameCompany(client, email, options.tenant);
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

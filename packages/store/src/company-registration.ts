import { withTransaction, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

export interface CompanyRegistration {
  email: string; name: string; passwordHash: string; company: { slug: string; name: string };
}
export interface RegisteredCompany {
  user: { id: string; username: string; email: string; name: string };
  company: { id: string; slug: string; name: string };
  hub: { id: string; name: string };
}
export async function registerCompany(pool: DatabasePool, input: CompanyRegistration): Promise<RegisteredCompany> {
  try {
    return await withTransaction(pool, async client => {
      await client.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
      const row = (await client.query<{ human_id: string; tenant_id: string; actor_alias: string }>(
        'SELECT human_id,tenant_id,actor_alias FROM cauce_register_company($1,$2,$3,$4,$5)',
        [input.email, input.name, input.passwordHash, input.company.slug, input.company.name],
      )).rows[0];
      if (!row) throw new StoreError('conflict', 'registration has no durable receipt');
      return { user: { id: row.human_id, username: row.actor_alias, email: input.email, name: input.name },
        company: { id: input.company.slug, slug: input.company.slug, name: input.company.name },
        hub: { id: row.tenant_id, name: input.company.name } };
    }, { schemaLockTimeoutMs: 2_000 });
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === '23505') throw new StoreError('conflict', 'registration is unavailable; use another email or company identifier');
    if (code === '22023') throw new StoreError('invalid_input', 'registration is invalid');
    throw error;
  }
}

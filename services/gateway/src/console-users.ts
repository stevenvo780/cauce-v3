import { isAnyUuid } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';

/**
 * Storage and access for the `console_users` table.
 */

export type ConsoleUserRole = 'operator' | 'reader';

export interface ConsoleUser {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: ConsoleUserRole;
  readonly tenant_id: string;
  readonly alias: string;
  readonly active: boolean;
  readonly password_hash: string;
  /** Epoch ms. Any JWT issued before this marker is no longer valid. */
  readonly password_changed_at: number;
  readonly password_changed_at_us?: string;
}

export interface ConsoleUserStore {
  ready(): Promise<void>;
  findByEmail(email: string): Promise<ConsoleUser | undefined>;
  findById(id: string): Promise<ConsoleUser | undefined>;
  updateDisplayName(id: string, name: string): Promise<string | undefined>;
  recordLogin(id: string, at: Date): Promise<void>;
}

/** Single, shared email normalization. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface ConsoleUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  tenant_id: string;
  alias: string;
  active: boolean;
  password_hash: string;
  password_changed_at: Date;
  password_changed_at_us: string;
}

function toUser(row: ConsoleUserRow): ConsoleUser {
  if (row.role !== 'operator' && row.role !== 'reader') {
    throw new Error(`console_users.role desconocido: ${row.role}`);
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    tenant_id: row.tenant_id,
    alias: row.alias,
    active: row.active,
    password_hash: row.password_hash,
    password_changed_at: row.password_changed_at.getTime(),
    password_changed_at_us: row.password_changed_at_us
  };
}

const COLUMNS =
  'id, email, display_name, role, tenant_id, alias, active, password_hash, password_changed_at, '
  + '(extract(epoch FROM password_changed_at)*1000000)::numeric(20,0)::text AS password_changed_at_us';

export class PostgresConsoleUserStore implements ConsoleUserStore {
  constructor(private readonly pool: DatabasePool) {}

  async ready(): Promise<void> {
    await this.pool.query('SELECT id FROM console_users LIMIT 0');
  }

  /**
   * Looks up a user by the normalized email, including inactive accounts so the
   * provider can handle the error flow in a uniform way.
   */
  async findByEmail(email: string): Promise<ConsoleUser | undefined> {
    const result = await this.pool.query<ConsoleUserRow>(
      `SELECT ${COLUMNS} FROM console_users WHERE email_normalized=$1`, [normalizeEmail(email)]
    );
    return result.rows[0] === undefined ? undefined : toUser(result.rows[0]);
  }

  async findById(id: string): Promise<ConsoleUser | undefined> {
    // The id comes from the `sub` of an already-verified JWT, but if it is not a uuid PostgreSQL
    // aborts the query with 22P02 and that would be a 500 instead of a 401. It is filtered first.
    if (!isAnyUuid(id)) return undefined;
    const result = await this.pool.query<ConsoleUserRow>(
      `SELECT ${COLUMNS} FROM console_users WHERE id=$1::uuid`, [id]
    );
    return result.rows[0] === undefined ? undefined : toUser(result.rows[0]);
  }

  async updateDisplayName(id: string, name: string): Promise<string | undefined> {
    if (!isAnyUuid(id)) return undefined;
    const result = await this.pool.query<{ display_name: string }>(
      'UPDATE console_users SET display_name=$2, updated_at=now() WHERE id=$1::uuid AND active=true RETURNING display_name',
      [id, name]
    );
    return result.rows[0]?.display_name;
  }

  /** Best-effort: a failure writing the last-login marker must not bring down the login. */
  async recordLogin(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE console_users SET last_login_at=$2 WHERE id=$1::uuid', [id, at]);
  }
}

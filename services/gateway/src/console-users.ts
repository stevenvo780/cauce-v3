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
}

export interface ConsoleUserStore {
  ready(): Promise<void>;
  findByEmail(email: string): Promise<ConsoleUser | undefined>;
  findById(id: string): Promise<ConsoleUser | undefined>;
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
    password_changed_at: row.password_changed_at.getTime()
  };
}

const COLUMNS =
  'id, email, display_name, role, tenant_id, alias, active, password_hash, password_changed_at';

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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    const result = await this.pool.query<ConsoleUserRow>(
      `SELECT ${COLUMNS} FROM console_users WHERE id=$1::uuid`, [id]
    );
    return result.rows[0] === undefined ? undefined : toUser(result.rows[0]);
  }

  /** Best-effort: a failure writing the last-login marker must not bring down the login. */
  async recordLogin(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE console_users SET last_login_at=$2 WHERE id=$1::uuid', [id, at]);
  }
}

/** In-memory store for the provider's tests. Not used in production. */
export class MemoryConsoleUserStore implements ConsoleUserStore {
  private readonly users = new Map<string, ConsoleUser>();

  constructor(users: readonly ConsoleUser[] = []) {
    for (const user of users) this.users.set(user.id, user);
  }

  async ready(): Promise<void> {}

  async findByEmail(email: string): Promise<ConsoleUser | undefined> {
    const normalized = normalizeEmail(email);
    return [...this.users.values()].find((user) => normalizeEmail(user.email) === normalized);
  }

  async findById(id: string): Promise<ConsoleUser | undefined> {
    return this.users.get(id);
  }

  async recordLogin(): Promise<void> {}

  put(user: ConsoleUser): void {
    this.users.set(user.id, user);
  }
}

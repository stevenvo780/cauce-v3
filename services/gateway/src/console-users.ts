import type { DatabasePool } from '@cauce/store';

/**
 * Lectura de `console_users`. La tabla la crea la migración 023 y este módulo NUNCA hace DDL:
 * `ready()` falla el arranque si la tabla no está, que es la única forma de que un despliegue
 * con la base sin migrar no llegue a la pantalla de login pareciendo sano.
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
  /** Epoch ms. Todo JWT emitido antes de esta marca deja de valer. */
  readonly password_changed_at: number;
}

export interface ConsoleUserStore {
  ready(): Promise<void>;
  findByEmail(email: string): Promise<ConsoleUser | undefined>;
  findById(id: string): Promise<ConsoleUser | undefined>;
  recordLogin(id: string, at: Date): Promise<void>;
}

/** Normalización única y compartida: la misma que impone el índice de la migración 023. */
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
   * Trae también las cuentas desactivadas a propósito: quien decide es el proveedor, y devolver
   * `undefined` acá haría que "cuenta apagada" y "correo inexistente" tomaran caminos distintos
   * —uno con verificación de contraseña y otro sin ella— que se distinguen midiendo el tiempo.
   */
  async findByEmail(email: string): Promise<ConsoleUser | undefined> {
    const result = await this.pool.query<ConsoleUserRow>(
      `SELECT ${COLUMNS} FROM console_users WHERE email_normalized=$1`, [normalizeEmail(email)]
    );
    return result.rows[0] === undefined ? undefined : toUser(result.rows[0]);
  }

  async findById(id: string): Promise<ConsoleUser | undefined> {
    // El id sale del `sub` de un JWT ya verificado, pero si no es un uuid PostgreSQL aborta la
    // consulta con 22P02 y eso sería un 500 en vez de un 401. Se filtra antes.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    const result = await this.pool.query<ConsoleUserRow>(
      `SELECT ${COLUMNS} FROM console_users WHERE id=$1::uuid`, [id]
    );
    return result.rows[0] === undefined ? undefined : toUser(result.rows[0]);
  }

  /** Best-effort: un fallo escribiendo la marca de último ingreso no puede tumbar el login. */
  async recordLogin(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE console_users SET last_login_at=$2 WHERE id=$1::uuid', [id, at]);
  }
}

/** Store en memoria para los tests del proveedor. No se usa en producción. */
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

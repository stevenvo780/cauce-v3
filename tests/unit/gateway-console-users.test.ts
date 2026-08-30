import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import {
  MemoryConsoleUserStore,
  normalizeEmail,
  PostgresConsoleUserStore,
  type ConsoleUser,
} from '../../services/gateway/src/console-users.js';

/**
 * Tests for `services/gateway/src/console-users.ts`.
 *
 * The file was sitting at 0 % in vitest. Two surfaces are covered here:
 *
 *  * `normalizeEmail` and the row-to-domain conversion reached through it — pure
 *    functions, exercised with concrete inputs and without touching the database;
 *  * the two store implementations:
 *      - `PostgresConsoleUserStore` is driven by a `vi.fn()`-backed `DatabasePool`,
 *        so every query the store sends is captured and asserted on (parameters,
 *        SQL fragment, return value);
 *      - `MemoryConsoleUserStore` is verified end-to-end because the provider's own
 *        tests depend on it.
 */

const VALID_UUID = '70000000-0000-4000-8000-000000000001';

function makeRow(overrides: Partial<{
  id: string;
  email: string;
  display_name: string;
  role: string;
  tenant_id: string;
  alias: string;
  active: boolean;
  password_hash: string;
  password_changed_at: Date;
}> = {}): {
  id: string;
  email: string;
  display_name: string;
  role: string;
  tenant_id: string;
  alias: string;
  active: boolean;
  password_hash: string;
  password_changed_at: Date;
} {
  const baseDate = new Date('2026-08-26T10:00:00.000Z');
  return {
    id: VALID_UUID,
    email: 'kant@example.com',
    display_name: 'Kant',
    role: 'operator',
    tenant_id: 'Steven',
    alias: 'kant',
    active: true,
    password_hash: '$scrypt$n=32768,r=8,p=1$abc$def',
    password_changed_at: baseDate,
    ...overrides,
  };
}

function makePool(impl?: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>): {
  pool: DatabasePool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (impl) return impl(sql, params);
    return { rows: [], rowCount: 0 };
  });
  const pool = { query } as unknown as DatabasePool;
  return { pool, query };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('normalizeEmail', () => {
  it('trim + lower: "USER@example.com  " se vuelve "user@example.com"', () => {
    expect(normalizeEmail('USER@example.com  ')).toBe('user@example.com');
  });

  it('idempotente: una dirección ya normalizada vuelve igual', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
    expect(normalizeEmail('user@example.com')).toBe(normalizeEmail('user@example.com'));
  });

  it('empty string y whitespace-only producen string vacío (no null)', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail('   \t\n')).toBe('');
  });

  it('preserva caracteres no ASCII del local-part sin lanzar', () => {
    const unicodeEmail = 'ÚŚEŘ@exämple.com';
    const normalized = normalizeEmail(unicodeEmail);
    expect(normalized).toBe(unicodeEmail.toLowerCase());
    expect(normalized).toContain('@');
  });
});

describe('toUser (conversión fila → ConsoleUser, ejercida via findByEmail)', () => {
  it('role "operator" válido: la fila se transforma en ConsoleUser con password_changed_at como epoch ms', async () => {
    const row = makeRow({ role: 'operator', password_changed_at: new Date('2026-08-26T10:00:00.000Z') });
    const { pool, query } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    const user = await store.findByEmail('kant@example.com');

    expect(user).toBeDefined();
    expect(user?.role).toBe('operator');
    expect(user?.password_changed_at).toBe(row.password_changed_at.getTime());
    expect(user?.email).toBe('kant@example.com');
    expect(user?.active).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('role "reader" válido: también se acepta', async () => {
    const row = makeRow({ role: 'reader' });
    const { pool } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    const user = await store.findByEmail('kant@example.com');

    expect(user?.role).toBe('reader');
  });

  it('role desconocido en la fila: la conversión lanza con un mensaje que menciona el role', async () => {
    const row = makeRow({ role: 'admin' });
    const { pool } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    await expect(store.findByEmail('kant@example.com')).rejects.toThrow(/role desconocido.*admin/);
  });
});

describe('PostgresConsoleUserStore.findByEmail', () => {
  it('email encontrado: devuelve el usuario normalizado', async () => {
    const row = makeRow();
    const { pool } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    const user = await store.findByEmail('kant@example.com');

    expect(user).toBeDefined();
    expect(user?.id).toBe(VALID_UUID);
    expect(user?.email).toBe('kant@example.com');
    expect(user?.role).toBe('operator');
  });

  it('email no encontrado (rows vacías): devuelve undefined', async () => {
    const { pool } = makePool(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresConsoleUserStore(pool);

    expect(await store.findByEmail('nobody@example.com')).toBeUndefined();
  });

  it('la query se ejecuta con email_normalizado (lowercase + trim), NO con el email crudo', async () => {
    const { pool, query } = makePool(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresConsoleUserStore(pool);

    await store.findByEmail('  KANT@Example.COM ');

    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0]!;
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('WHERE email_normalized=$1');
    // Normalizado: lowercase + trim. NO se manda el email crudo en MAYÚSCULAS.
    expect(params[0]).toBe('kant@example.com');
    expect(params[0]).not.toBe('  KANT@Example.COM ');
  });
});

describe('PostgresConsoleUserStore.findById', () => {
  it('UUID válido + fila presente: devuelve el usuario (encontrado por id, sin filtrar por email)', async () => {
    const row = makeRow();
    const { pool, query } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    const user = await store.findById(VALID_UUID);

    expect(user?.id).toBe(VALID_UUID);
    expect(user?.email).toBe('kant@example.com');
    const call = query.mock.calls[0]!;
    expect(String(call[0])).toContain('WHERE id=$1::uuid');
  });

  it('id NO UUID: devuelve undefined SIN tocar la query (evita 22P02 → 500)', async () => {
    const { pool, query } = makePool();
    const store = new PostgresConsoleUserStore(pool);

    expect(await store.findById('not-a-uuid')).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('UUID válido pero no encontrado: devuelve undefined', async () => {
    const { pool, query } = makePool(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresConsoleUserStore(pool);

    expect(await store.findById('00000000-0000-4000-8000-000000000099')).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual(['00000000-0000-4000-8000-000000000099']);
  });

  it('fila presente con role desconocido: la conversión a ConsoleUser lanza', async () => {
    const row = makeRow({ role: 'superuser' });
    const { pool } = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    await expect(store.findById(VALID_UUID)).rejects.toThrow(/role desconocido/);
  });
});

describe('PostgresConsoleUserStore.recordLogin', () => {
  it('ejecuta UPDATE con id y timestamp at como parámetros', async () => {
    const at = new Date('2026-08-30T12:34:56.000Z');
    const { pool, query } = makePool(async () => ({ rows: [], rowCount: 1 }));
    const store = new PostgresConsoleUserStore(pool);

    await store.recordLogin(VALID_UUID, at);

    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0]!;
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('UPDATE console_users');
    expect(sql).toContain('SET last_login_at=$2');
    expect(sql).toContain('WHERE id=$1::uuid');
    expect(params[0]).toBe(VALID_UUID);
    expect(params[1]).toBe(at);
  });

  it('best-effort: si el pool falla, el error se propaga (la doc dice best-effort pero el assert de la query es lo que se cubre)', async () => {
    const { pool, query } = makePool();
    query.mockRejectedValueOnce(new Error('connection lost'));
    const store = new PostgresConsoleUserStore(pool);

    await expect(store.recordLogin(VALID_UUID, new Date())).rejects.toThrow(/connection lost/);
  });
});

describe('PostgresConsoleUserStore.ready', () => {
  it('ejecuta un SELECT EXISTS-LIMIT-0 sobre console_users como ping de esquema', async () => {
    const { pool, query } = makePool(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresConsoleUserStore(pool);

    await store.ready();

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain('SELECT id FROM console_users LIMIT 0');
  });
});

describe('MemoryConsoleUserStore', () => {
  const baseUser: ConsoleUser = {
    id: '70000000-0000-4000-8000-000000000001',
    email: 'Kant@Example.com',
    display_name: 'Kant',
    role: 'operator',
    tenant_id: 'Steven',
    alias: 'kant',
    active: true,
    password_hash: '$scrypt$n=32768,r=8,p=1$abc$def',
    password_changed_at: 1_700_000_000_000,
  };

  it('put + findById devuelve el usuario agregado', async () => {
    const store = new MemoryConsoleUserStore();
    store.put(baseUser);

    expect(await store.findById(baseUser.id)).toEqual(baseUser);
  });

  it('findByEmail normaliza ambos lados de la comparación (casing + whitespace)', async () => {
    const store = new MemoryConsoleUserStore([baseUser]);

    expect(await store.findByEmail('kant@example.com')).toEqual(baseUser);
    expect(await store.findByEmail('  KANT@EXAMPLE.COM  ')).toEqual(baseUser);
  });

  it('findByEmail y findById devuelven undefined cuando no hay match', async () => {
    const store = new MemoryConsoleUserStore([baseUser]);

    expect(await store.findByEmail('nobody@example.com')).toBeUndefined();
    expect(await store.findById('00000000-0000-4000-8000-000000000099')).toBeUndefined();
  });

  it('constructor con users[]: los precarga indexando por id', async () => {
    const store = new MemoryConsoleUserStore([baseUser]);

    expect(await store.findById(baseUser.id)).toEqual(baseUser);
  });

  it('ready y recordLogin son no-ops (no fallan, devuelven void)', async () => {
    const store = new MemoryConsoleUserStore();

    await expect(store.ready()).resolves.toBeUndefined();
    // `MemoryConsoleUserStore.recordLogin` es deliberadamente un no-op (no-track): los argumentos
    // del contrato del store se ignoran a propósito, los tests del provider lo ejercen aparte.
    await expect((store as unknown as { recordLogin: () => Promise<void> }).recordLogin()).resolves.toBeUndefined();
  });
});

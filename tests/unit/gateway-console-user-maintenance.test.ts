import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { maintainConsoleUser, type ConsoleUserMaintenance } from '../../services/gateway/src/console-user-maintenance.js';

const omitted: ConsoleUserMaintenance = {
  email: 'Person@Example.test', name: undefined, role: undefined, tenant: undefined,
  alias: undefined, updateOnly: false, activate: false,
};
const existing = {
  id: 'fixture-person', email: 'person@example.test', display_name: 'Persona', role: 'reader',
  tenant_id: 'Equipo', alias: 'salva', active: false, password_hash: 'old-fixture-hash',
  password_changed_at: 1,
};

function stringParameter(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a string parameter');
  return value;
}

function fixture(initial?: typeof existing) {
  let account = initial === undefined ? undefined : { ...initial };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO human_tenant_memberships')) {
      expect(params).toHaveLength(5);
      expect(params[0]).toBe(account?.id);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO console_users')) {
      expect(sql).toContain('ON CONFLICT (email_normalized) DO NOTHING');
      expect(sql).toContain('RETURNING id, role, tenant_id, alias, active');
      expect(sql).toContain("VALUES ($8,$1,$2,COALESCE($3,split_part($8,'@',1)),COALESCE($4,'operator'),");
      expect(params[0]).toBe('person@example.test');
      expect(params).toHaveLength(8);
      if (params[2] === '') throw new Error('fixture constraint rejection');
      if (account !== undefined) return { rows: [], rowCount: 0 };
      account = {
        ...existing, id: 'fixture-person', email: stringParameter(params[7]),
        display_name: params[2] === null ? stringParameter(params[7]).split('@')[0] ?? '' : stringParameter(params[2]),
        role: params[3] === null ? 'operator' : stringParameter(params[3]),
        tenant_id: params[4] === null ? 'Steven' : stringParameter(params[4]),
        alias: params[5] === null ? 'kant' : stringParameter(params[5]),
        active: true, password_hash: stringParameter(params[1]), password_changed_at: 1,
      };
      return { rows: [{ ...account }], rowCount: 1 };
    }
    if (!sql.startsWith('UPDATE console_users SET')) throw new Error('Unexpected maintenance query');
    const assignments = sql.split('SET ')[1];
    expect(assignments).toBeDefined();
    expect(assignments).toContain('password_hash=$2');
    for (const [field, index] of [['display_name', 3], ['role', 4], ['tenant_id', 5], ['alias', 6], ['active', 7]]) {
      expect(assignments).toContain(`${String(field)}=COALESCE($${String(index)},console_users.${String(field)})`);
    }
    expect(assignments).toContain('password_changed_at=CURRENT_TIMESTAMP');
    expect(assignments).toContain('updated_at=CURRENT_TIMESTAMP');
    expect(assignments).not.toMatch(/(?:^|[\s,])email\s*=|EXCLUDED\.|active=true/);
    expect(sql).toContain('RETURNING id, role, tenant_id, alias, active');
    expect(params[0]).toBe('person@example.test');
    expect(params).toHaveLength(7);
    if (account === undefined) {
      expect(sql).not.toContain('INSERT');
      return { rows: [], rowCount: 0 };
    }
    // This double models only the asserted statement contract; it is not a SQL engine.
    account = { ...account,
      display_name: params[2] === null ? account.display_name : stringParameter(params[2]), role: params[3] === null ? account.role : stringParameter(params[3]),
      tenant_id: params[4] === null ? account.tenant_id : stringParameter(params[4]), alias: params[5] === null ? account.alias : stringParameter(params[5]),
      active: params[6] === null ? account.active : params[6] === true,
      password_hash: stringParameter(params[1]), password_changed_at: account.password_changed_at + 1 };
    return { rows: [{ ...account }], rowCount: 1 };
  });
  const pool = {
    query,
    connect: async () => ({ query, release: vi.fn(), on: vi.fn(), off: vi.fn() }),
  } as unknown as DatabasePool;
  return { pool, query, current: () => account };
}

describe('mantenimiento de usuarios: contrato de persistencia', () => {
  it.each([true, false])('dos cambios de contraseña preservan atributos y active=%s', async (active) => {
    const before = { ...existing, active };
    const store = fixture(before);
    await maintainConsoleUser(store.pool, omitted, 'new-fixture-hash');
    await maintainConsoleUser(store.pool, omitted, 'newer-fixture-hash');
    expect(store.current()).toEqual({ ...before, password_hash: 'newer-fixture-hash', password_changed_at: 3 });
    expect(store.query).toHaveBeenCalledTimes(8);
    const firstUpdate = store.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE console_users SET'));
    expect(firstUpdate?.[1]).toEqual([
      'person@example.test', 'new-fixture-hash', null, null, null, null, null,
    ]);
  });

  it('un alta conserva todos los defaults y empieza activa', async () => {
    const store = fixture();
    await maintainConsoleUser(store.pool, omitted, 'new-fixture-hash');
    expect(store.current()).toMatchObject({ email: 'Person@Example.test', display_name: 'Person',
      role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true });
  });

  it.each([
    [{ name: 'Nombre explícito' }, { display_name: 'Nombre explícito' }],
    [{ role: 'operator' as const }, { role: 'operator' }],
    [{ tenant: 'Otro equipo' }, { tenant_id: 'Otro equipo' }],
    [{ alias: 'zeus' }, { alias: 'zeus' }],
  ])('modifica únicamente el atributo explícito %j', async (options, change) => {
    const store = fixture(existing);
    await maintainConsoleUser(store.pool, { ...omitted, ...options }, 'new-fixture-hash');
    expect(store.current()).toEqual({ ...existing, ...change, password_hash: 'new-fixture-hash', password_changed_at: 2 });
  });

  it('un nombre vacío sigue siendo explícito y no oculta un rechazo de la base', async () => {
    const query = vi.fn(async (sql: string, _params: unknown[]) => {
      if (sql.startsWith('INSERT INTO console_users')) throw new Error('fixture constraint rejection');
      return { rows: [], rowCount: 0 };
    });
    const pool = {
      query,
      connect: async () => ({ query, release: vi.fn(), on: vi.fn(), off: vi.fn() }),
    } as unknown as DatabasePool;
    await expect(maintainConsoleUser(pool, { ...omitted, name: '' }, 'new-fixture-hash'))
      .rejects.toThrow('fixture constraint rejection');
    expect(query).toHaveBeenCalledTimes(3);
    const insert = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO console_users'));
    expect(insert?.[1]).toEqual([
      'person@example.test', 'new-fixture-hash', '', null, null, null, null, 'Person@Example.test',
    ]);
  });

  it('preserva el error original y destruye la conexion si el rollback falla', async () => {
    const originalError = new Error('fixture insert failure');
    const rollbackError = new Error('rollback network drop');
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO console_users')) throw originalError;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [], rowCount: 0 };
    });
    const pool = {
      query,
      connect: async () => ({
        query,
        release,
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as DatabasePool;

    await expect(maintainConsoleUser(pool, omitted, 'new-fixture-hash'))
      .rejects.toThrow('fixture insert failure');
    expect(release).toHaveBeenCalledWith(true);
  });

  it('un alta respeta nombre, rol y ámbito explícitos', async () => {
    const store = fixture();
    await maintainConsoleUser(store.pool, { ...omitted, name: 'Otra persona', role: 'reader', tenant: 'Equipo', alias: 'salva' }, 'new-fixture-hash');
    expect(store.current()).toMatchObject({ display_name: 'Otra persona', role: 'reader', tenant_id: 'Equipo', alias: 'salva', active: true });
  });

  it('update falla sin crear si la cuenta no existe', async () => {
    const store = fixture();
    await expect(maintainConsoleUser(store.pool, { ...omitted, updateOnly: true }, 'new-fixture-hash')).rejects.toThrow(/no existe una cuenta/);
    expect(store.current()).toBeUndefined();
    expect(store.query).toHaveBeenCalledTimes(1);
  });

  it('update mantiene la baja salvo activate explícito y siempre avanza la marca de sesión', async () => {
    const store = fixture(existing);
    await maintainConsoleUser(store.pool, { ...omitted, updateOnly: true }, 'new-fixture-hash');
    expect(store.current()).toEqual({ ...existing, password_hash: 'new-fixture-hash', password_changed_at: 2 });
    const saved = await maintainConsoleUser(store.pool, { ...omitted, updateOnly: true, activate: true }, 'newer-fixture-hash');
    expect(store.current()).toEqual({ ...existing, active: true, password_hash: 'newer-fixture-hash', password_changed_at: 3 });
    expect(saved).toMatchObject({ role: 'reader', tenant_id: 'Equipo', alias: 'salva', active: true });
  });

  it('activate no crea una cuenta ausente', async () => {
    const store = fixture();
    await expect(maintainConsoleUser(store.pool, { ...omitted, updateOnly: true, activate: true }, 'new-fixture-hash')).rejects.toThrow(/no existe una cuenta/);
    expect(store.current()).toBeUndefined();
  });
});

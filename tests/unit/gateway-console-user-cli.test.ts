import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';

function exigir<T>(valor: T | undefined, que: string): T {
  if (valor === undefined) throw new Error(`se esperaba ${que} y no lo hubo`);
  return valor;
}


interface CliRun {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  pool: DatabasePool;
}

function createStubPool(impl?: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>): CliRun {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (impl) return impl(sql, params);
    return { rows: [], rowCount: 0 };
  });
  const end = vi.fn(async () => undefined);
  const pool = { query, end } as unknown as DatabasePool;
  return { query, end, pool };
}

async function importUnitStoreMock(createPool: (connectionString: string, options?: unknown) => DatabasePool) {
  return {
    createPool: vi.fn(createPool),
    withTransaction: async <T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> =>
      work({ query: pool.query.bind(pool), on: vi.fn(), off: vi.fn(), release: vi.fn() } as unknown as DatabaseClient),
  };
}

async function importCli(): Promise<unknown> {
  return import('../../services/gateway/src/console-user-cli.js');
}

let stub: CliRun;
let originalArgv: string[];
let originalDatabaseUrl: string | undefined;
let originalPasswordEnv: string | undefined;

beforeEach(() => {
  vi.resetModules();
  stub = createStubPool();
  vi.doMock('@cauce/store', () => importUnitStoreMock((_connectionString) => stub.pool));
  vi.doMock('../../services/gateway/src/password.js', () => ({
    assertPasswordPolicy: vi.fn(),
    hashPassword: vi.fn(async () => 'MOCKED-SCRYPT-HASH'),
  }));
  originalArgv = process.argv;
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalPasswordEnv = process.env.CAUCE_CONSOLE_USER_PASSWORD;
  process.env.DATABASE_URL = 'postgres://fake';
  process.env.CAUCE_CONSOLE_USER_PASSWORD = 'a-long-enough-password';
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalPasswordEnv === undefined) Reflect.deleteProperty(process.env, 'CAUCE_CONSOLE_USER_PASSWORD');
  else process.env.CAUCE_CONSOLE_USER_PASSWORD = originalPasswordEnv;
  vi.doUnmock('@cauce/store');
  vi.doUnmock('../../services/gateway/src/password.js');
  vi.doUnmock('node:readline');
});

function buildFakeReadlineFactory(answers: readonly string[]): () => {
  close: () => void;
  question: (_prompt: string, cb: (answer: string) => void) => void;
} {
  const queue: string[] = [...answers];
  return () => ({
    question(_prompt, cb) {
      const answer = queue.shift() ?? '';
      cb(answer);
    },
    close: vi.fn(),
  });
}

function enableTty(answers: readonly string[]): void {


  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const createInterface = vi.fn().mockImplementation(buildFakeReadlineFactory(answers));
  vi.doMock('node:readline', () => ({ createInterface }));


  Object.defineProperty(process.stdout, 'write', {
    configurable: true,
    writable: true,
    value: process.stdout.write.bind(process.stdout),
  });
}

describe('carga del módulo (efectos al importar)', () => {
  it('lanza si DATABASE_URL no está definida (el CLI debe fallar antes de tocar la red)', async () => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c'];

    await expect(importCli()).rejects.toThrow(/DATABASE_URL/);
    expect(stub.query).not.toHaveBeenCalled();
  });
});

describe('parseArguments — validaciones que tiran ANTES de tocar la base', () => {
  it('sin --email: el módulo rechaza al cargar (--email es obligatorio)', async () => {
    process.argv = ['node', 'console-user-cli.js', '--name', 'A', '--role', 'operator', '--tenant', 'Steven', '--alias', 'kant'];

    await expect(importCli()).rejects.toThrow(/-email es obligatorio/);
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('--email presente pero NO parece un correo: rechaza', async () => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'no-es-correo'];

    await expect(importCli()).rejects.toThrow(/-email es obligatorio/);
  });

  it('--role con un valor fuera del set {operator, reader}: rechaza con mención explícita', async () => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--role', 'admin'];

    await expect(importCli()).rejects.toThrow(/--role debe ser operator o reader/);
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('--alias que no cumple la regex [a-z][a-z0-9_-]{1,63}: rechaza', async () => {

    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'Kant'];

    await expect(importCli()).rejects.toThrow(/--alias inválido/);
  });

  it('--alias demasiado corto (0 chars tras la primera letra): rechaza', async () => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'k'];

    await expect(importCli()).rejects.toThrow(/--alias inválido/);
  });

  it('--password está prohibido por argv (debe ir por env o prompt)', async () => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--password', 'a-long-enough-password'];

    await expect(importCli()).rejects.toThrow(/contraseña no se pasa por argumento/);
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('argumento posicional sin prefijo "--": rechaza como "argumento inesperado"', async () => {
    process.argv = ['node', 'console-user-cli.js', 'kludge', '--email', 'a@b.c'];

    await expect(importCli()).rejects.toThrow(/argumento inesperado: kludge/);
  });

  it('flag sin valor al final del argv (sin compañero): rechaza', async () => {

    process.argv = ['node', 'console-user-cli.js', '--email'];

    await expect(importCli()).rejects.toThrow(/falta el valor de --email/);
  });
});

describe('parseArguments — última gana con flags duplicados', () => {
  it('dos --email: el segundo sobreescribe al primero (NO se mezclan)', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000001', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email', 'primero@example.com',
      '--email', 'segundo@example.com',
      '--name', 'Second',
      '--role', 'operator',
      '--tenant', 'Steven',
      '--alias', 'kant',
    ];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(2);
    const call = exigir(stub.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO console_users')),
      'el INSERT de la cuenta');
    const params = call[1] as unknown[];

    expect(params[7]).toBe('segundo@example.com');
    expect(params[0]).toBe('segundo@example.com');
  });
});

describe('alta de cuenta (INSERT con ON CONFLICT)', () => {
  it('happy path con todos los flags: emite INSERT con email crudo + email_normalizado', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000001', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email', 'User@Example.com  ',
      '--name', 'A',
      '--role', 'operator',
      '--tenant', 'Steven',
      '--alias', 'kant',
    ];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(2);
    const call = exigir(stub.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO console_users')),
      'el INSERT de la cuenta');
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('INSERT INTO console_users');
    expect(sql).toContain('ON CONFLICT (email_normalized) DO NOTHING');

    expect(params[7]).toBe('User@Example.com'.trim());
    expect(params[0]).toBe('user@example.com');

    expect(params[1]).toBe('MOCKED-SCRYPT-HASH');

    expect(params[2]).toBe('A');
    expect(params[3]).toBe('operator');
    expect(params[4]).toBe('Steven');
    expect(params[5]).toBe('kant');

    const calls = stub.query.mock.calls as unknown as [unknown, unknown][];
    expect(calls.some(([statement, rawParams]) => {
      if (!String(statement).startsWith('INSERT INTO human_tenant_memberships') || !Array.isArray(rawParams)) return false;
      return rawParams[0] === row.id && rawParams[3] === 'operator';
    })).toBe(true);

    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('role "reader" se persiste en la fila INSERT', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000002', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email', 'reader@example.com',
      '--role', 'reader',
      '--alias', 'salva',
    ];

    await importCli();

    const params = exigir(stub.query.mock.calls[0], 'una llamada registrada')[1] as unknown[];
    expect(params[3]).toBe('reader');
  });

  it('valores por defecto: sin --name deriva del local-part; sin --alias usa kant; sin --tenant usa Steven; sin --role usa operator', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000003', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    process.argv = ['node', 'console-user-cli.js', '--email', 'kant@example.com'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(2);
    const insert = exigir(stub.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO console_users')),
      'el INSERT de la cuenta');
    const params = insert[1] as unknown[];
    expect(params.slice(2, 7)).toEqual([null, null, null, null, null]);
    const sql = String(insert[0]);
    expect(sql).toContain("COALESCE($3,split_part($8,'@',1))");
    expect(sql).toContain("COALESCE($4,'operator')");
    expect(sql).toContain("COALESCE($5,'Steven')");
    expect(sql).toContain("COALESCE($6,'kant')");
  });

  it('forma --email=valor se acepta (igual que --email valor)', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000004', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email=kant@example.com',
      '--alias', 'kant',
    ];

    await importCli();

    const params = exigir(stub.query.mock.calls[0], 'una llamada registrada')[1] as unknown[];
    expect(params[7]).toBe('kant@example.com');
    expect(params[0]).toBe('kant@example.com');
  });

  it('cuenta existente: cierra el pool después de guardar', async () => {
    stub.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000005', role: 'reader', tenant_id: 'Equipo', alias: 'salva', active: false }], rowCount: 1 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(2);
    expect(stub.query.mock.calls[0]?.[0]).toContain('ON CONFLICT (email_normalized) DO NOTHING');
    expect(stub.query.mock.calls[1]?.[0]).toMatch(/^UPDATE console_users SET/);


    expect(stub.end).toHaveBeenCalledTimes(1);
  });
});

describe('desactivación de cuenta (UPDATE active=false)', () => {
  it('--deactivate con email conocido: emite UPDATE con email_normalizado y termina', async () => {
    stub.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.c', active: false }], rowCount: 1 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'A@B.c', '--deactivate'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(1);
    const call = exigir(stub.query.mock.calls[0], 'una llamada registrada');
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('UPDATE console_users SET active=false');
    expect(sql).toContain('RETURNING email, active');

    expect(params).toEqual(['a@b.c']);
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('--deactivate sin email: el módulo rechaza al cargar (email es obligatorio)', async () => {
    process.argv = ['node', 'console-user-cli.js', '--deactivate'];

    await expect(importCli()).rejects.toThrow(/-email es obligatorio/);
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('--deactivate con email que NO existe (rowCount !== 1): lanza "no existe una cuenta"', async () => {
    stub.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'fantasma@example.com', '--deactivate'];

    await expect(importCli()).rejects.toThrow(/no existe una cuenta de consola para fantasma@example.com/);

    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('createPool se llama una sola vez, con la URL de DATABASE_URL y applicationName del CLI', async () => {
    const createPoolSpy = vi.fn((connectionString: string, options?: unknown): DatabasePool => {
      void connectionString;
      void options;
      return stub.pool;
    });
    vi.doMock('@cauce/store', () => importUnitStoreMock(createPoolSpy));
    stub.query.mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000099', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true }], rowCount: 1 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await importCli();

    expect(createPoolSpy).toHaveBeenCalledTimes(1);
    const call = createPoolSpy.mock.calls[0];
    expect(call).toBeDefined();
    const args = call as unknown as [string, { max: number; applicationName: string }];
    expect(args[0]).toBe('postgres://fake');
    expect(args[1]).toMatchObject({ max: 2, applicationName: 'cauce-console-user' });
  });
});

describe('lectura interactiva de la contraseña (promptPassword + readPassword)', () => {
  it('sin TTY: el módulo falla con "pasá la contraseña en CAUCE_CONSOLE_USER_PASSWORD"', async () => {

    Reflect.deleteProperty(process.env, 'CAUCE_CONSOLE_USER_PASSWORD');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await expect(importCli()).rejects.toThrow(/sin TTY.*CAUCE_CONSOLE_USER_PASSWORD/);
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('con TTY y dos ingresos IGUALES: el INSERT usa el hash determinista del prompt', async () => {
    Reflect.deleteProperty(process.env, 'CAUCE_CONSOLE_USER_PASSWORD');
    enableTty(['a-long-enough-password', 'a-long-enough-password']);
    stub.query.mockResolvedValueOnce({
      rows: [{ id: '00000000-0000-4000-8000-000000000010', role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true }],
      rowCount: 1,
    });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await importCli();

    const params = exigir(stub.query.mock.calls[0], 'una llamada registrada')[1] as unknown[];

    expect(params[1]).toBe('MOCKED-SCRYPT-HASH');
  });

  it('con TTY y dos ingresos DISTINTOS: la validación "no coinciden" tira antes del INSERT', async () => {
    Reflect.deleteProperty(process.env, 'CAUCE_CONSOLE_USER_PASSWORD');
    enableTty(['a-long-enough-password', 'otra-cosa-distinta']);
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await expect(importCli()).rejects.toThrow(/las contraseñas no coinciden/);
    expect(stub.query).not.toHaveBeenCalled();
  });
});


describe('mantenimiento conservador de una cuenta existente', () => {
  it('una contraseña nueva no reactiva ni reescribe atributos omitidos', async () => {
    const account = { id: '00000000-0000-4000-8000-000000000050', email: 'A@B.c',
      display_name: 'Persona existente', role: 'reader', tenant_id: 'Equipo', alias: 'salva',
      active: false, created_at: new Date(0), updated_at: new Date(1) };
    stub = createStubPool(async (sql, params) => {
      if (sql.startsWith('INSERT INTO console_users')) {
        expect(sql).toContain('ON CONFLICT (email_normalized) DO NOTHING');
        return { rows: [], rowCount: 0 };
      }
      expect(sql).toMatch(/^UPDATE console_users SET/);
      expect(params).toEqual(['a@b.c', 'MOCKED-SCRYPT-HASH', null, null, null, null, null]);
      expect(sql).toContain('display_name=COALESCE($3,console_users.display_name)');
      expect(sql).toContain('role=COALESCE($4,console_users.role)');
      expect(sql).toContain('tenant_id=COALESCE($5,console_users.tenant_id)');
      expect(sql).toContain('alias=COALESCE($6,console_users.alias)');
      expect(sql).toContain('active=COALESCE($7,console_users.active)');
      const changed = { ...account };
      expect(changed).toEqual(account);
      return { rows: [{ id: changed.id, role: changed.role, tenant_id: changed.tenant_id,
        alias: changed.alias, active: changed.active }], rowCount: 1 };
    });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c'];
    await importCli();
    expect(stub.end).toHaveBeenCalledTimes(1);
  });
});

describe('operaciones explícitas y errores sin efectos', () => {
  it.each([
    ['--activate'], ['--activate', '--deactivate'], ['--update', '--deactivate'],
    ['--deactivate', '--role', 'reader'], ['--udpate', 'true'], ['--activate=false'],
  ])('rechaza una combinación inválida: %j', async (...flags) => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', ...flags];
    await expect(importCli()).rejects.toThrow();
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('--update no crea una cuenta ausente y cierra el pool', async () => {
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--update'];
    await expect(importCli()).rejects.toThrow(/no existe una cuenta/);
    expect(stub.query).toHaveBeenCalledTimes(1);
    expect(stub.query.mock.calls[0]?.[0]).toMatch(/^UPDATE console_users SET/);
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('--update --activate pide reactivación explícita y muestra la fila persistida', async () => {
    stub.query.mockResolvedValueOnce({ rows: [{ id: 'test-id', role: 'reader', tenant_id: 'Equipo', alias: 'salva', active: true }], rowCount: 1 });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--update', '--activate'];
      await importCli();
      expect(stub.query.mock.calls[0]?.[1]).toEqual(['a@b.c', 'MOCKED-SCRYPT-HASH', null, null, null, null, true]);
      expect(output).toHaveBeenCalledWith('  rol     reader');
      expect(output).toHaveBeenCalledWith('  actúa   Equipo:salva');
      expect(output).toHaveBeenCalledWith('  activa  sí');
    } finally { output.mockRestore(); }
  });

  it('un error de persistencia se propaga y cierra el pool', async () => {
    stub.query.mockRejectedValueOnce(new Error('fixture database failure'));
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c'];
    await expect(importCli()).rejects.toThrow('fixture database failure');
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('una contraseña rechazada no emite ninguna consulta', async () => {
    vi.doMock('../../services/gateway/src/password.js', () => ({
      assertPasswordPolicy: () => { throw new Error('fixture policy failure'); },
      hashPassword: vi.fn(),
    }));
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c'];
    await expect(importCli()).rejects.toThrow('fixture policy failure');
    expect(stub.query).not.toHaveBeenCalled();
    expect(stub.end).toHaveBeenCalledTimes(1);
  });
});

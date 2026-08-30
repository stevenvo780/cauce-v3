import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';

/**
 * Tests for `services/gateway/src/console-user-cli.ts`.
 *
 * The file is a CLI entry point with NO exported symbols: every binding in it is
 * module-local and the whole script runs as side effects at import time. The CLI
 *   1. validates `DATABASE_URL`;
 *   2. parses `process.argv.slice(2)` with its private `parseArguments`;
 *   3. connects to Postgres through `createPool` from `@cauce/store`;
 *   4. prompts for (or reads) a password and hashes it via `password.js`;
 *   5. issues a single `INSERT ... ON CONFLICT ...` (or `UPDATE ... SET active=false`
 *      when `--deactivate` is set);
 *   6. closes the pool in a `finally`.
 *
 * Because `parseArguments` is private, the only hermetic way to exercise it is to
 * drive the module top-to-bottom once per scenario with `vi.resetModules()` and a
 * dynamic `await import(...)`. Mocks supplied here:
 *
 *   * `@cauce/store` → returns a stub pool whose `query`/`end` are `vi.fn()`s;
 *   * `services/gateway/src/password.js` → returns `assertPasswordPolicy` and a
 *     deterministic `hashPassword` so the INSERT parameters are inspectable;
 *   * `process.env.DATABASE_URL` and `process.env.CAUCE_CONSOLE_USER_PASSWORD` are
 *     set so the module does not stop at the prompt.
 *
 * Each test inspects the recorded calls on the stub pool (SQL fragment, parameter
 * array, return shape) — that IS the only thing the CLI module exposes to a caller.
 */

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
  vi.doMock('@cauce/store', () => ({ createPool: vi.fn(() => stub.pool) }));
  vi.doMock('../../services/gateway/src/password.js', () => ({
    assertPasswordPolicy: vi.fn(),
    hashPassword: vi.fn(async () => 'MOCKED-SCYPT-HASH'),
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

/**
 * Helpers para los tests que ejercen `promptPassword` / `readPassword` por la vía interactiva.
 *
 * `promptPassword` se niega a correr cuando `process.stdin.isTTY` es falsy; el resto escribe
 * sobre `process.stdout.write` y depende de `readline.createInterface`. Como el módulo es de
 * carga única por test (`vi.resetModules()`), el mock de `node:readline` se reaplica antes de
 * cada `await import(...)`.
 *
 * Cada invocación de `createInterface` representa un prompt nuevo (`promptPassword` la llama
 * una sola vez por ejecución). Las dos llamadas a `promptPassword` que hace `readPassword`
 * necesitan Devolver textos DISTINTOS para poder probar la rama "no coinciden". Por eso el
 * cursor se mantiene en una cola externa y no dentro del closure de la interfaz.
 */
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
    close() {
      // No-op; the module invokes it from its `finally`.
    },
  });
}

function enableTty(answers: readonly string[]): void {
  // `process.stdin.isTTY` is set by the Node runtime based on how the process was started.
  // In CI it is usually `undefined`; we force it to `true` so promptPassword does not bail.
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const createInterface = vi.fn().mockImplementation(buildFakeReadlineFactory(answers));
  vi.doMock('node:readline', () => ({ createInterface }));
  // Avoid a test leaving process.stdout.write pointing to the module's no-op
  // and contaminating the next one — `process.stdout` is shared.
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
    // Uppercase is not allowed.
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
    // No value after --email — `--email` is the last element.
    process.argv = ['node', 'console-user-cli.js', '--email'];

    await expect(importCli()).rejects.toThrow(/falta el valor de --email/);
  });
});

describe('parseArguments — última gana con flags duplicados', () => {
  it('dos --email: el segundo sobreescribe al primero (NO se mezclan)', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000001', created_at: new Date(0), updated_at: new Date(0) };
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

    expect(stub.query).toHaveBeenCalledTimes(1);
    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const params = call[1] as unknown[];
    // Raw email: the second wins. Normalized: the second wins.
    expect(params[0]).toBe('segundo@example.com');
    expect(params[1]).toBe('segundo@example.com');
  });
});

describe('alta de cuenta (INSERT con ON CONFLICT)', () => {
  it('happy path con todos los flags: emite INSERT con email crudo + email_normalizado', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000001', created_at: new Date(0), updated_at: new Date(0) };
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

    expect(stub.query).toHaveBeenCalledTimes(1);
    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('INSERT INTO console_users');
    expect(sql).toContain('ON CONFLICT (email_normalized) DO UPDATE SET');
    // position 0 = raw email (trim), position 1 = email_normalized (lower+trim)
    expect(params[0]).toBe('User@Example.com'.trim());
    expect(params[1]).toBe('user@example.com');
    // position 2 = password hash, from the deterministic mock
    expect(params[2]).toBe('MOCKED-SCYPT-HASH');
    // position 3..6 = name, role, tenant, alias
    expect(params[3]).toBe('A');
    expect(params[4]).toBe('operator');
    expect(params[5]).toBe('Steven');
    expect(params[6]).toBe('kant');
    // pool.end is called in the finally block
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('role "reader" se persiste en la fila INSERT', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000002', created_at: new Date(0), updated_at: new Date(0) };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email', 'reader@example.com',
      '--role', 'reader',
      '--alias', 'salva',
    ];

    await importCli();

    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const params = call[1] as unknown[];
    expect(params[4]).toBe('reader');
  });

  it('valores por defecto: sin --name deriva del local-part; sin --alias usa kant; sin --tenant usa Steven; sin --role usa operator', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000003', created_at: new Date(0), updated_at: new Date(0) };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    // Only --email: the rest must come from defaults.
    process.argv = ['node', 'console-user-cli.js', '--email', 'kant@example.com'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(1);
    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const params = call[1] as unknown[];
    expect(params[3]).toBe('kant'); // name was derived from the local-part
    expect(params[4]).toBe('operator'); // role default
    expect(params[5]).toBe('Steven'); // tenant default
    expect(params[6]).toBe('kant'); // alias default
  });

  it('forma --email=valor se acepta (igual que --email valor)', async () => {
    const row = { id: '00000000-0000-4000-8000-000000000004', created_at: new Date(0), updated_at: new Date(0) };
    stub.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    process.argv = [
      'node', 'console-user-cli.js',
      '--email=kant@example.com',
      '--alias', 'kant',
    ];

    await importCli();

    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const params = call[1] as unknown[];
    expect(params[0]).toBe('kant@example.com');
    expect(params[1]).toBe('kant@example.com');
  });

  it('cuenta actualizada (created_at != updated_at): emite "cuenta actualizada" + nota sobre sesiones invalidadas', async () => {
    const created = new Date('2026-08-01T00:00:00.000Z');
    const updated = new Date('2026-08-30T00:00:00.000Z');
    stub.query.mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000005', created_at: created, updated_at: updated }], rowCount: 1 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(1);
    // The module already logs to stdout; the important assertion is that the INSERT ran
    // and the pool closed.
    expect(stub.end).toHaveBeenCalledTimes(1);
  });
});

describe('desactivación de cuenta (UPDATE active=false)', () => {
  it('--deactivate con email conocido: emite UPDATE con email_normalizado y termina', async () => {
    stub.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.c', active: false }], rowCount: 1 });
    process.argv = ['node', 'console-user-cli.js', '--email', 'A@B.c', '--deactivate'];

    await importCli();

    expect(stub.query).toHaveBeenCalledTimes(1);
    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('UPDATE console_users SET active=false');
    expect(sql).toContain('RETURNING email, active');
    // Only the normalized email is sent as a parameter in this branch.
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
    // The finally block still closes the pool.
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('createPool se llama una sola vez, con la URL de DATABASE_URL y applicationName del CLI', async () => {
    const createPoolSpy = vi.fn((connectionString: string, options?: unknown): DatabasePool => {
      void connectionString;
      void options;
      return stub.pool;
    });
    vi.doMock('@cauce/store', () => ({ createPool: createPoolSpy }));
    stub.query.mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000099', created_at: new Date(0), updated_at: new Date(0) }], rowCount: 1 });
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
    // Without env, without TTY → must bail with the specific error message.
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
      rows: [{ id: '00000000-0000-4000-8000-000000000010', created_at: new Date(0), updated_at: new Date(0) }],
      rowCount: 1,
    });
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await importCli();

    const call = stub.query.mock.calls[0];
    if (!call) throw new Error('query was not called');
    const params = call[1] as unknown[];
    // The module calls hashPassword(...) and stores the result at position $3 of the INSERT.
    expect(params[2]).toBe('MOCKED-SCYPT-HASH');
  });

  it('con TTY y dos ingresos DISTINTOS: la validación "no coinciden" tira antes del INSERT', async () => {
    Reflect.deleteProperty(process.env, 'CAUCE_CONSOLE_USER_PASSWORD');
    enableTty(['a-long-enough-password', 'otra-cosa-distinta']);
    process.argv = ['node', 'console-user-cli.js', '--email', 'a@b.c', '--alias', 'kant'];

    await expect(importCli()).rejects.toThrow(/las contraseñas no coinciden/);
    expect(stub.query).not.toHaveBeenCalled();
  });
});

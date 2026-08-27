import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrateCli = join(repository, 'packages/store/src/migrate-cli.ts');
const tsx = join(repository, 'node_modules/.bin/tsx');
const directDiagnostic =
  'direct migration is disabled: use ops/scripts/deploy-release.sh deploy for the ' +
  'stop/drain/migrate/restore transaction';

function executableEnvironment(nodeEnv?: 'production' | 'test'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  };
}

describe('direct migration CLI production tombstone', () => {
  it('fails before reading database configuration when executed directly in production', () => {
    const result = spawnSync(tsx, [migrateCli], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment('production'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(directDiagnostic);
    expect(result.stderr).not.toContain('DATABASE_URL is required');
  });

  it('also fails closed when NODE_ENV is absent', () => {
    const result = spawnSync(tsx, [migrateCli], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment(),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(directDiagnostic);
    expect(result.stderr).not.toContain('DATABASE_URL is required');
  });

  it('preserves the direct CLI for test and development environments', () => {
    const result = spawnSync(tsx, [migrateCli], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment('test'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DATABASE_URL is required');
    expect(result.stderr).not.toContain(directDiagnostic);
  });

  it('makes every retired wrapper fail before reading database configuration', () => {
    const invocations: Array<[string, string[]]> = [
      ['make', ['--silent', 'migrate']],
      ['make', ['--silent', '-C', 'ops', 'migrate']],
      [join(repository, 'ops/scripts/migrate.sh'), []],
    ];
    for (const [command, arguments_] of invocations) {
      const result = spawnSync(command, arguments_, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...executableEnvironment(), DATABASE_URL_FILE: '/definitely/not/read' },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(directDiagnostic);
      expect(result.stderr).not.toContain('DATABASE_URL_FILE is not readable');
    }
  });

  it('keeps pnpm migrate as the same fail-closed tombstone', () => {
    const result = spawnSync('pnpm', ['migrate'], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment('test'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(directDiagnostic);
  });

  it('requires an explicit dev/test environment even on the migrate:dev script', () => {
    const result = spawnSync('pnpm', ['migrate:dev'], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment(),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(directDiagnostic);
    expect(result.stderr).not.toContain('DATABASE_URL is required');
  });

  it('preserves the root migrate-dev target for explicit test environments', () => {
    const result = spawnSync('make', ['--silent', 'migrate-dev'], {
      cwd: repository,
      encoding: 'utf8',
      env: executableEnvironment('test'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DATABASE_URL is required');
    expect(result.stderr).not.toContain(directDiagnostic);
  });
});

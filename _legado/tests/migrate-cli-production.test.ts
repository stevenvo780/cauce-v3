import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const directDiagnostic =
  'direct migration is disabled: use ops/scripts/deploy-release.sh deploy for the ' +
  'stop/drain/migrate/restore transaction';

function executableEnvironment(nodeEnv?: 'production' | 'test'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  };
}

describe('retired direct migration wrappers', () => {
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
});

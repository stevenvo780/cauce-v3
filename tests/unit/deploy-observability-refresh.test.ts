import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const refresh = join(root, 'deploy/refresh-observability.sh');

function execute(running: string, failure = '') {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-observability-refresh-'));
  const compose = join(directory, 'docker');
  const environment = join(directory, 'prod.env');
  const log = join(directory, 'compose.log');
  writeFileSync(environment, 'COMPOSE_PROJECT_NAME=test\n');
  writeFileSync(compose, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_COMPOSE_LOG"
command_name=''
for argument in "$@"; do
  case "$argument" in ps|up) command_name="$argument"; break ;; esac
done
if [ "$command_name" = ps ]; then
  [ "\${MOCK_COMPOSE_FAILURE:-}" != ps ] || exit 17
  printf '%b' "\${MOCK_RUNNING_SERVICES:-}"
  exit 0
fi
if [ "$command_name" = up ]; then
  [ "\${MOCK_COMPOSE_FAILURE:-}" != up ] || exit 19
  exit 0
fi
exit 23
`);
  chmodSync(compose, 0o755);
  const result = spawnSync(refresh, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAUCE_ENV_FILE: environment,
      CAUCE_OBSERVABILITY_COMPOSE_BIN: compose,
      MOCK_COMPOSE_LOG: log,
      MOCK_RUNNING_SERVICES: running,
      MOCK_COMPOSE_FAILURE: failure,
    },
  });
  const commands = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  rmSync(directory, { recursive: true, force: true });
  return {
    ...result,
    commands,
  };
}

describe('observability bind-mount refresh', () => {
  it('force-recreates only observability services already running', () => {
    const result = execute('prometheus\notel-collector\ngateway\n');
    expect(result.status).toBe(0);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toContain('compose --env-file');
    expect(result.commands[0]).toContain('ps --status running --services');
    expect(result.commands[1]).toContain(
      'up -d --no-deps --force-recreate --wait --wait-timeout 120 prometheus otel-collector',
    );
    expect(result.commands[1]).not.toContain('gateway');
  });

  it('does not start an inactive observability profile or service', () => {
    const result = execute('prometheus\n');
    expect(result.status).toBe(0);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[1]).toMatch(/ prometheus$/u);
    expect(result.commands[1]).not.toContain('otel-collector');

    const absent = execute('gateway\n');
    expect(absent.status).toBe(0);
    expect(absent.commands).toHaveLength(1);
    expect(absent.stdout).toContain('no se habilita ningun perfil');
  });

  it.each(['ps', 'up'])('fails closed when compose %s fails', (failure) => {
    const result = execute('prometheus\n', failure);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(failure === 'ps'
      ? 'no pude consultar los servicios activos'
      : 'fallo el refresco de observabilidad');
  });

  it('runs the refresh after canonical up and before smoke', () => {
    const deploy = readFileSync(join(root, 'deploy/deploy.sh'), 'utf8');
    const up = deploy.indexOf('up -d --wait --wait-timeout 300 --remove-orphans');
    const refreshCall = deploy.indexOf('deploy/refresh-observability.sh');
    const smoke = deploy.indexOf('deploy/smoke.sh');
    expect(up).toBeGreaterThan(-1);
    expect(refreshCall).toBeGreaterThan(up);
    expect(smoke).toBeGreaterThan(refreshCall);
  });
});

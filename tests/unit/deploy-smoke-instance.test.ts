import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const smoke = join(root, 'deploy/smoke.sh');
const expectedMigration = readdirSync(join(root, 'packages/store/migrations'))
  .filter((name) => /^\d.*\.sql$/u.test(name))
  .sort()
  .at(-1);

const completeEnvironment = `COMPOSE_PROJECT_NAME=hospital-cauce
POSTGRES_USER=hospital_user
POSTGRES_DB=hospital_db
COMPOSE_PROFILES=telegram
CAUCE_CONSOLE_URL=https://hospital-console.example.test
CAUCE_SMOKE_GOVERNANCE_ALIAS=hospital-leader
CAUCE_SMOKE_GOVERNANCE_TENANT=Hospital
CAUCE_SMOKE_REQUIRE_GOVERNANCE_AGENT=1
CAUCE_SMOKE_EXPECTED_AGENTS=3
CAUCE_SMOKE_LEASE_FRESH_SECONDS=60
CAUCE_SMOKE_MIN_ACTIVITY=1
CAUCE_SMOKE_ACTIVITY_WINDOW_SECONDS=21600
CAUCE_SMOKE_MAX_ATTEMPTS=1
CAUCE_SMOKE_RETRY_SECONDS=0
CAUCE_SMOKE_RELAY_MAX_CONNECTIONS=30
`;

function execute(environmentText: string, extraEnvironment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-instance-smoke-'));
  const docker = join(directory, 'docker');
  const curl = join(directory, 'curl');
  const environment = join(directory, 'instance.env');
  const consoleCa = join(directory, 'console-ca.crt');
  const log = join(directory, 'commands.log');
  writeFileSync(environment, environmentText);
  writeFileSync(consoleCa, 'test-only-ca');
  writeFileSync(docker, `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
if [ "\${1:-}" = compose ]; then
  if [[ " $* " == *" config --services "* ]]; then
    printf '%s\\n' migrator postgres gateway dispatcher outbox-metrics console
    [[ " $* " == *" --profile telegram "* ]] && printf '%s\\n' telegram-bridge
    [[ " $* " == *" --profile terminal "* ]] && printf '%s\\n' terminal-relay
    if [[ " $* " == *" --profile observability "* ]]; then
      printf '%s\\n' otel-collector prometheus
    fi
    exit 0
  fi
  if [[ " $* " == *" ps -q "* ]]; then
    printf 'cid-%s\\n' "\${!#}"
    exit 0
  fi
  exit 91
fi
if [ "\${1:-}" = inspect ]; then
  case "\${3:-}" in
    *Health.Status*) printf 'healthy\\n' ;;
    *StartedAt*) printf '2026-09-05T20:00:00.000000000Z\\n' ;;
    *) exit 92 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = exec ]; then
  if [ "\${2:-}" = cid-gateway ]; then
    exit 0
  fi
  case "$*" in
    *'SELECT max(version) FROM schema_migrations'*) printf '%s\\n' "$MOCK_EXPECTED_MIGRATION" ;;
    *'FROM agents a LEFT JOIN connection_leases'*) printf '3|3\\n' ;;
    *'FROM agents WHERE'*) printf '1\\n' ;;
    *"status='done'"*) printf '1\\n' ;;
    *"status IN ('leased','accepted','started')"*) printf '0\\n' ;;
    *) exit 93 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = logs ]; then
  printf '%s\\n' '{"event":"terminal_relay_agent_connected"}' '{"event":"terminal_relay_agent_connected"}'
  exit 0
fi
exit 94
`);
  writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
printf '%s' "\${MOCK_CURL_CODE:-401}"
`);
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  const instanceKeys = new Set([
    'COMPOSE_PROJECT_NAME',
    'POSTGRES_USER',
    'POSTGRES_DB',
    'COMPOSE_PROFILES',
    'CAUCE_CONSOLE_URL',
    'CAUCE_SMOKE_GOVERNANCE_ALIAS',
    'CAUCE_SMOKE_GOVERNANCE_TENANT',
    'CAUCE_SMOKE_REQUIRE_GOVERNANCE_AGENT',
    'CAUCE_SMOKE_EXPECTED_AGENTS',
    'CAUCE_SMOKE_LEASE_FRESH_SECONDS',
    'CAUCE_SMOKE_MIN_ACTIVITY',
    'CAUCE_SMOKE_ACTIVITY_WINDOW_SECONDS',
    'CAUCE_SMOKE_MAX_ATTEMPTS',
    'CAUCE_SMOKE_RETRY_SECONDS',
    'CAUCE_SMOKE_RELAY_MAX_CONNECTIONS',
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !instanceKeys.has(key)),
  );
  const result = spawnSync(smoke, [], {
    encoding: 'utf8',
    env: {
      ...inherited,
      CAUCE_ENV_FILE: environment,
      CAUCE_SMOKE_DOCKER_BIN: docker,
      CAUCE_SMOKE_CURL_BIN: curl,
      CAUCE_CONSOLE_TLS_CA_PATH: consoleCa,
      MOCK_COMMAND_LOG: log,
      MOCK_EXPECTED_MIGRATION: expectedMigration,
      ...extraEnvironment,
    },
  });
  const commands = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  rmSync(directory, { recursive: true, force: true });
  return { ...result, commands };
}

describe('instance-aware deploy smoke', () => {
  it('resolves active-profile containers through compose and uses the instance database', () => {
    const result = execute(completeEnvironment);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('telegram-bridge healthy');
    expect(result.stdout).toContain('3/3 agentes habilitados con arriendo vigente y fresco');
    expect(result.stdout).toContain('Hospital/hospital-leader existe y está habilitado');
    expect(result.commands.some((command) => command.includes(
      'compose --env-file') && command.includes('--profile telegram') && command.endsWith('config --services'),
    )).toBe(true);
    for (const service of ['postgres', 'gateway', 'dispatcher', 'outbox-metrics', 'console', 'telegram-bridge']) {
      expect(result.commands.some((command) => command.endsWith(`ps -q ${service}`))).toBe(true);
    }
    expect(result.commands.some((command) => command.includes(
      'exec cid-postgres psql -X -U hospital_user -d hospital_db',
    ))).toBe(true);
    expect(result.commands.join('\n')).not.toContain('cauce-v3-prod');
    expect(result.commands.join('\n')).not.toContain('terminal-relay');
    expect(result.commands.join('\n')).not.toContain('/agents/zeus/');
  });

  it('probes terminal and observability only when their profiles are active', () => {
    const result = execute(completeEnvironment.replace(
      'COMPOSE_PROFILES=telegram',
      'COMPOSE_PROFILES=terminal,observability',
    ));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('relay: 2 conexiones/2min');
    for (const service of ['terminal-relay', 'otel-collector', 'prometheus']) {
      expect(result.commands.some((command) => command.endsWith(`ps -q ${service}`))).toBe(true);
    }
    expect(result.commands.join('\n')).not.toContain('ps -q telegram-bridge');
  });

  it('fails before Docker when instance-specific expectations are absent', () => {
    const result = execute(`COMPOSE_PROJECT_NAME=hospital-cauce
POSTGRES_USER=hospital_user
POSTGRES_DB=hospital_db
COMPOSE_PROFILES=
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CAUCE_CONSOLE_URL debe declararse para esta instancia');
    expect(result.commands).toEqual([]);
  });

  it('rejects a server error from the governance route', () => {
    const result = execute(completeEnvironment, { MOCK_CURL_CODE: '500' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('ROJO ruta documents de hospital-leader: 500');
  });
});

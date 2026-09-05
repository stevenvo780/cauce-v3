import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const schema = readdirSync(join(root, 'packages/store/migrations'))
  .filter((name) => /^\d.*\.sql$/u.test(name)).sort().at(-1) ?? '';

function smoke(count: number, stream = 'stderr', failure = false, fleet = '15|15', http = '401', overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-smoke-relay-'));
  try {
    writeFileSync(join(directory, 'docker'), `#!/usr/bin/env bash
case "$1" in
  inspect)
    if [[ "$*" == *StartedAt* ]]; then printf '%s' "$MOCK_START"
    elif [ -n "$MOCK_UNHEALTHY" ] && [[ "$*" == *"prod-$MOCK_UNHEALTHY-1"* ]]; then printf unhealthy
    else printf healthy; fi ;;
  exec)
    if [[ "$*" == *schema_migrations* ]]; then printf '%s' "$MOCK_SCHEMA"
    elif [[ "$*" == *'FROM agents a'* ]]; then
      if [ "$MOCK_FLEET" = error ]; then exit 17; fi
      printf '%s' "$MOCK_FLEET"
    elif [[ "$*" == *"d.status='done'"* ]]; then printf '%s' "$MOCK_DONE"
    else printf '%s' "$MOCK_INFLIGHT"; fi ;;
  logs)
    if [ "$MOCK_LOG_FAILURE" = 1 ]; then printf 'private-diagnostic-sentinel' >&2; exit 19; fi
    for ((i=0;i<MOCK_LOG_COUNT;i++)); do
      if [ "$MOCK_LOG_STREAM" = stdout ] || { [ "$MOCK_LOG_STREAM" = both ] && ((i%2==0)); }; then
        printf '%s\\n' '{"event":"terminal_relay_agent_connected"}'
      else printf '%s\\n' '{"event":"terminal_relay_agent_connected"}' >&2; fi
    done ;;
  *) exit 23 ;;
esac
`);
    writeFileSync(join(directory, 'curl'), '#!/usr/bin/env bash\n[[ "$*" == *"--cacert "* && "$*" != *"-sk"* ]] || exit 51\nprintf "%s" "$MOCK_HTTP"\nexit "$MOCK_CURL_EXIT"\n');
    writeFileSync(join(directory, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const name of ['docker', 'curl', 'sleep']) chmodSync(join(directory, name), 0o755);
    return spawnSync('bash', [join(root, 'deploy/smoke.sh')], {
      encoding: 'utf8', timeout: 5_000,
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        MOCK_SCHEMA: schema, MOCK_START: new Date(0).toISOString(),
        MOCK_LOG_COUNT: String(count), MOCK_LOG_STREAM: stream,
        MOCK_LOG_FAILURE: failure ? '1' : '0',
        MOCK_FLEET: fleet, MOCK_HTTP: http,
        MOCK_CURL_EXIT: '0', MOCK_DONE: '1', MOCK_INFLIGHT: '0', MOCK_UNHEALTHY: '',
        CAUCE_SMOKE_EXPECTED_AGENTS: '15',
        ...overrides,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('deployment relay churn smoke', () => {
  it.each(['stderr', 'stdout', 'both'])('counts connection events from %s', (stream) => {
    const result = smoke(30, stream);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ROJO relay: 30 conexiones/2min');
    expect(result.stdout).not.toContain('OK  relay');
  });

  it.each([0, 29])('accepts %i connections only after successfully reading logs', (count) => {
    const result = smoke(count);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`OK  relay: ${String(count)} conexiones/2min`);
  });

  it('fails closed without exposing diagnostics when docker logs fails', () => {
    const result = smoke(0, 'stderr', true);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ROJO relay: no pude leer los logs');
    expect(result.stdout).not.toContain('OK  relay');
    expect(`${result.stdout}${result.stderr}`).not.toContain('private-diagnostic-sentinel');
  });

  it.each(['15|14', '15|8', '15|0', '14|14', '16|16', '0|0', '', 'error', '15|invalid'])('rejects incomplete or unavailable fleet census %s', (fleet) => {
    const result = smoke(0, 'stderr', false, fleet);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ROJO flota:');
    expect(result.stdout).not.toContain('OK  flota:');
  });

  it.each(['000', '200', '302', '404', '500', '502'])('rejects unexpected governance HTTP %s', (http) => {
    const result = smoke(0, 'stderr', false, '15|15', http);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`ROJO ruta documents: ${http}`);
  });

  it.each(['401', '403'])('accepts a deployed governance HTTP %s', (http) => {
    const result = smoke(0, 'stderr', false, '15|15', http);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK  flota: 15/15 agentes habilitados');
    expect(result.stdout).toContain(`OK  ruta documents responde ${http}`);
  });

  it('rejects failed curl even if it printed an accepted status code', () => {
    const result = smoke(0, 'stderr', false, '15|15', '401', { MOCK_CURL_EXIT: '28' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ROJO ruta documents: consulta HTTP fallida');
  });

  it.each(['postgres', 'prometheus', 'otel-collector', 'outbox-metrics'])('checks %s health as well as application containers', (container) => {
    const result = smoke(0, 'stderr', false, '15|15', '401', { MOCK_UNHEALTHY: container });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`ROJO ${container}: unhealthy`);
  });

  it.each(['0', '', 'invalid'])('requires proven bus progress instead of an unvalidated count %s', (count) => {
    const result = smoke(0, 'stderr', false, '15|15', '401', { MOCK_DONE: count });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ROJO bus:');
  });

  it('distinguishes an ongoing execution from a completed result', () => {
    const result = smoke(0, 'stderr', false, '15|15', '401', { MOCK_DONE: '0', MOCK_INFLIGHT: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sin resultado final acreditado');
  });

  it.each(['0', '-1', '15+1', 'invalid'])('rejects an invalid independent expected fleet size %s', (expected) => {
    const result = smoke(0, 'stderr', false, '15|15', '401', { CAUCE_SMOKE_EXPECTED_AGENTS: expected });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('cardinalidad esperada invalida');
  });

  it('allows an explicitly configured expected fleet size', () => {
    const result = smoke(0, 'stderr', false, '16|16', '401', { CAUCE_SMOKE_EXPECTED_AGENTS: '16' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK  flota: 16/16');
  });
});

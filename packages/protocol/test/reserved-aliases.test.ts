import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigMutationSchema, FleetOperationRequestSchema, RESERVED_CLI_ALIASES, isReservedAlias } from '../src/index.js';

const script = readFileSync(new URL('../../../ops/cli/cauce', import.meta.url), 'utf8');

function dispatchedSubcommands(): string[] {
  const names = new Set<string>();
  for (const match of script.matchAll(/\$\{1:-\} == ([a-z][a-z-]*)/gu)) names.add(match[1]!);
  const start = script.indexOf('case "${1:-}" in\n  ""|flota|estado)');
  const block = script.slice(start, script.indexOf('\n  *)', start));
  for (const arm of block.matchAll(/^ {2}([a-z"|-]+)\)/gmu)) {
    for (const name of arm[1]!.split('|')) if (/^[a-z]/u.test(name)) names.add(name);
  }
  return [...names];
}

describe('reserved CLI aliases', () => {
  it('matches the top-level subcommands dispatched by ops/cli/cauce', () => {
    expect([...RESERVED_CLI_ALIASES].sort()).toEqual(dispatchedSubcommands().sort());
  });

  it('is case insensitive', () => {
    expect(isReservedAlias('Platform')).toBe(true);
    expect(isReservedAlias('atlas')).toBe(false);
  });

  it.each(['platform', 'Platform'])('rejects creating a membership with alias %s', (alias) => {
    const result = ConfigMutationSchema.safeParse({
      resource: 'membership', action: 'create', tenant_id: 'nuevo', room_id: 'sala', alias,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reservado');
  });

  it.each(['platform', 'Platform'])('rejects creating an agent with alias %s', (alias) => {
    const result = ConfigMutationSchema.safeParse({ resource: 'agent', action: 'create', tenant_id: 'nuevo', alias });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reservado');
    expect(ConfigMutationSchema.safeParse({ resource: 'agent', action: 'create', tenant_id: 'nuevo', alias: 'atlas' }).success).toBe(true);
  });

  const fleetCreate = (alias: string, runtimeKey: string) => FleetOperationRequestSchema.safeParse({
    kind: 'create', target: { resource: 'agent', tenant_id: 'nuevo', alias }, expected_revision: 1, idempotency_key: 'key-12345678',
    parameters: { runtime_key: runtimeKey, harness_id: 'codex', primary_room_id: 'sala', memberships: [{ room_id: 'sala', role: 'agent' }],
      placement: { host_id: 'h1', mode: 'native', runtime_user: 'runner', home_directory: '/home/runner', state_directory: '/state/x' } },
  });

  it.each(['platform', 'Platform'])('rejects a fleet create with alias %s', (alias) => {
    const result = fleetCreate(alias, 'atlas-rt');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reservado');
  });

  it('rejects a fleet create whose runtime_key is a subcommand and accepts a normal one', () => {
    expect(fleetCreate('atlas', 'hosts').success).toBe(false);
    expect(fleetCreate('atlas', 'atlas-rt').success).toBe(true);
  });
});

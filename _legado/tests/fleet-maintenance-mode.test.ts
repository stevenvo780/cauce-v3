import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = join(repository, 'ops/scripts/fleet-gate-mode.sh');
const releaseGate = join(repository, 'ops/scripts/release-gate.sh');
const scratch: string[] = [];

type InventoryEntry = {
  tenant: string;
  room: string;
  membershipRole: string;
  harness: string;
  container: string;
  registryContainer?: string;
  user: string;
  home: string;
  stateDirectory: string;
};

type Inventory = {
  aliases: Record<string, InventoryEntry>;
  systemPrincipals: Record<string, Pick<InventoryEntry, 'tenant' | 'room' | 'membershipRole'>>;
  historicalAliases: Record<string, { tenant: string }>;
};

async function snapshot({ zeusActive }: { zeusActive: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-fleet-maintenance-'));
  scratch.push(root);
  const inventory = JSON.parse(
    await readFile(join(repository, 'ops/container-aliases.json'), 'utf8'),
  ) as Inventory;
  const aliases = Object.entries(inventory.aliases);
  const evidence = {
    schemaVersion: 3,
    agents: [
      ...aliases.map(([alias, entry]) => ({
        tenant_id: entry.tenant,
        alias,
        harness_id: entry.harness,
        enabled: true,
        container_name: entry.registryContainer ?? entry.container,
        runtime_user: entry.user,
        home_directory: entry.home,
        state_directory: entry.stateDirectory,
      })),
      ...Object.entries(inventory.historicalAliases).map(([alias, entry]) => ({
        tenant_id: entry.tenant,
        alias,
        enabled: false,
      })),
    ],
    memberships: [
      ...aliases.map(([alias, entry]) => ({
        tenant_id: entry.tenant,
        alias,
        room_id: entry.room,
        role: entry.membershipRole,
      })),
      ...Object.entries(inventory.systemPrincipals).map(([alias, entry]) => ({
        tenant_id: entry.tenant,
        alias,
        room_id: entry.room,
        role: entry.membershipRole,
      })),
    ],
    rolePolicies: [
      { role: 'agent_notify', allow_route: true, allow_read: true, allow_control: false, allow_notify: true },
    ],
    leases: aliases
      .filter(([alias]) => alias !== 'zeus' || zeusActive)
      .map(([alias, entry]) => ({ tenant_id: entry.tenant, alias, active: true })),
  };
  const file = join(root, 'fleet.json');
  await writeFile(file, `${JSON.stringify(evidence)}\n`);
  return file;
}

function run(mode: string, evidence: string, extra: Record<string, string> = {}) {
  return spawnSync(gate, [mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CAUCE_FLEET_SNAPSHOT_FILE: evidence,
      CAUCE_FLEET_TEST_MODE: '1',
      CAUCE_CHANGE_ID: '',
      CAUCE_MAINTENANCE_CONFIRM: '',
      ...extra,
    },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bounded fleet maintenance mode', () => {
  test('final mode is strict and the exact Zeus exception requires explicit matching confirmation', async () => {
    const complete = await snapshot({ zeusActive: true });
    const final = run('final', complete);
    expect(final.status).toBe(0);
    expect(final.stdout).toContain(
      'fleet parity passed: 15 enabled aliases, 1 system principals, 3 disabled historical aliases',
    );

    const zeusOffline = await snapshot({ zeusActive: false });
    const strict = run('final', zeusOffline);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('lease missing: Steven:zeus');

    const unconfirmed = run('maintenance-zeus', zeusOffline);
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain('non-secret CAUCE_CHANGE_ID');

    const confirmed = run('maintenance-zeus', zeusOffline, {
      CAUCE_CHANGE_ID: 'CHG-42',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:zeus:CHG-42',
    });
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout).toContain(
      'fleet parity passed: 15 enabled aliases, 1 system principals, 3 disabled historical aliases, 1 expected-offline maintenance identities',
    );
    expect(confirmed.stderr).toContain('final gate is mandatory');
  });

  test('maintenance mode fails when Zeus is still active or confirmation does not match', async () => {
    const complete = await snapshot({ zeusActive: true });
    const active = run('maintenance-zeus', complete, {
      CAUCE_CHANGE_ID: 'CHG-42',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:zeus:CHG-42',
    });
    expect(active.status).toBe(1);
    expect(active.stderr).toContain('maintenance-offline agent is active: Steven:zeus');

    const zeusOffline = await snapshot({ zeusActive: false });
    const mismatch = run('maintenance-zeus', zeusOffline, {
      CAUCE_CHANGE_ID: 'CHG-42',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:kant:CHG-42',
    });
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain('CAUCE_MAINTENANCE_CONFIRM');
  });

  test('legacy bootstrap mode is bounded to the same exact offline Zeus authority', async () => {
    const zeusOffline = await snapshot({ zeusActive: false });
    const confirmed = run('bootstrap-legacy', zeusOffline, {
      CAUCE_CHANGE_ID: 'CHG-LEGACY',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:zeus:CHG-LEGACY',
    });
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toContain('legacy pre-migration validation passed');

    const zeusActive = await snapshot({ zeusActive: true });
    const rejected = run('bootstrap-legacy', zeusActive, {
      CAUCE_CHANGE_ID: 'CHG-LEGACY',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:zeus:CHG-LEGACY',
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('maintenance-offline agent is active: Steven:zeus');
  });

  test('release entry point rejects broader maintenance arguments', () => {
    expect(spawnSync(releaseGate, ['--maintenance-offline-kant'], { encoding: 'utf8' }).status).toBe(2);
  });
});

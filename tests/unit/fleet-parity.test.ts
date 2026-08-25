import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = join(repository, 'ops/scripts/fleet-parity.py');
const scratch: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cauce-fleet-parity-'));
  scratch.push(root);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'container-aliases.json'), JSON.stringify({
    schemaVersion: 2,
    systemPrincipals: {
      'quota-collector': {
        tenant: 'Steven', room: 'grp.steven', membershipRole: 'operator',
      },
    },
    historicalAliases: {
      heraclito: {
        tenant: 'Jhon', expectedEnabled: false, placementPolicy: 'preserve-database',
        retiredByMigration: '029_reconcile_declared_fleet.sql', lastDeclaredRuntime: null,
      },
    },
    aliases: {
      kant: {
        tenant: 'Steven', room: 'grp.steven', container: 'ctrl-infra', registryContainer: 'host:kratos', user: 'dev',
        home: '/home/dev', stateDirectory: '/state/kant', harness: 'codex', membershipRole: 'operator',
      },
      iza: {
        tenant: 'Miguel', room: 'grp.miguel', container: 'ws-humanizar', user: 'dev',
        home: '/home/dev', stateDirectory: '/state/iza', harness: 'hermes', membershipRole: 'agent',
      },
    },
  }));
  const snapshot = join(root, 'snapshot.json');
  const base = {
    schemaVersion: 3,
    agents: [
      { tenant_id: 'Steven', alias: 'kant', harness_id: 'codex', enabled: true, container_name: 'host:kratos', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/state/kant' },
      { tenant_id: 'Miguel', alias: 'iza', harness_id: 'hermes', enabled: true, container_name: 'ws-humanizar', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/state/iza' },
      { tenant_id: 'Jhon', alias: 'heraclito', harness_id: 'openclaw', enabled: false, container_name: 'historic', runtime_user: 'claw', home_directory: '/home/claw', state_directory: '/state/heraclito' },
    ],
    memberships: [
      { tenant_id: 'Steven', alias: 'kant', room_id: 'grp.steven', role: 'operator' },
      { tenant_id: 'Miguel', alias: 'iza', room_id: 'grp.miguel', role: 'agent' },
      { tenant_id: 'Steven', alias: 'quota-collector', room_id: 'grp.steven', role: 'operator' },
    ],
    rolePolicies: [
      { role: 'agent_notify', allow_route: true, allow_read: true, allow_control: false, allow_notify: true },
    ],
    leases: [
      { tenant_id: 'Steven', alias: 'kant', active: true },
      { tenant_id: 'Miguel', alias: 'iza', active: true },
    ],
  };
  return { root, snapshot, base };
}

function run(root: string, snapshot: string, extra: string[] = []) {
  return spawnSync('python3', [verifier, '--ops-root', root, '--snapshot', snapshot, ...extra], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('fleet parity gate', () => {
  test('accepts exact enabled placement, membership and active leases', async () => {
    const { root, snapshot, base } = await fixture();
    await writeFile(snapshot, JSON.stringify(base));
    const result = run(root, snapshot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 enabled aliases, 1 system principals, 1 disabled historical aliases');
  });

  test('reports undeclared, missing and placement drift without exposing row contents', async () => {
    const { root, snapshot, base } = await fixture();
    base.agents[0]!.container_name = 'wrong';
    base.agents.push({ tenant_id: 'Jhon', alias: 'ghost', harness_id: 'openclaw', enabled: true, container_name: 'ghost', runtime_user: 'claw', home_directory: '/home/claw', state_directory: '/state/ghost' });
    base.agents[1]!.enabled = false;
    await writeFile(snapshot, JSON.stringify(base));
    const result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('enabled agent missing: Miguel:iza');
    expect(result.stderr).toContain('undeclared enabled agent: Jhon:ghost');
    expect(result.stderr).toContain('placement mismatch Steven:kant field=container_name');
  });

  test('requires expected membership and lease unless an explicit maintenance identity is offline', async () => {
    const { root, snapshot, base } = await fixture();
    base.memberships = base.memberships.filter((item) => item.alias !== 'iza');
    base.leases = base.leases.filter((item) => item.alias !== 'kant');
    await writeFile(snapshot, JSON.stringify(base));
    let result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('membership missing: Miguel:iza:grp.miguel:agent');
    expect(result.stderr).toContain('lease missing: Steven:kant');
    result = run(root, snapshot, ['--expect-offline', 'Steven:kant']);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('lease missing: Steven:kant');

    base.memberships.push({ tenant_id: 'Miguel', alias: 'iza', room_id: 'grp.miguel', role: 'agent' });
    await writeFile(snapshot, JSON.stringify(base));
    result = run(root, snapshot, ['--expect-offline', 'Steven:kant']);
    expect(result.status).toBe(0);
  });

  test('maintenance-offline is an assertion, not permission for an active or undeclared identity', async () => {
    const { root, snapshot, base } = await fixture();
    await writeFile(snapshot, JSON.stringify(base));

    let result = run(root, snapshot, ['--expect-offline', 'Steven:kant']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('maintenance-offline agent is active: Steven:kant');

    result = run(root, snapshot, ['--expect-offline', 'Steven:ghost']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offline exception is not declared: Steven:ghost');
  });

  test('fails closed on malformed or duplicate evidence', async () => {
    const { root, snapshot, base } = await fixture();
    base.leases.push({ ...base.leases[0]! });
    await writeFile(snapshot, JSON.stringify(base));
    const result = run(root, snapshot);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('duplicate identity Steven:kant');
  });

  test('certifies every effective agent_notify permission instead of trusting the role name', async () => {
    const { root, snapshot, base } = await fixture();
    base.rolePolicies[0]!.allow_control = true;
    await writeFile(snapshot, JSON.stringify(base));
    let result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('role policy mismatch: agent_notify field=allow_control');

    base.rolePolicies = [];
    await writeFile(snapshot, JSON.stringify(base));
    result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('role policy missing: agent_notify');
  });

  test('requires the declared system principal without an agent row and rejects active historical leases', async () => {
    const { root, snapshot, base } = await fixture();
    base.memberships = base.memberships.filter((item) => item.alias !== 'quota-collector');
    base.leases.push({ tenant_id: 'Jhon', alias: 'heraclito', active: true });
    await writeFile(snapshot, JSON.stringify(base));
    let result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('membership missing: Steven:quota-collector:grp.steven:operator');
    expect(result.stderr).toContain('undeclared active lease: Jhon:heraclito');

    result = run(root, snapshot, ['--allow-extra-lease', 'Jhon:heraclito']);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('undeclared active lease: Jhon:heraclito');
  });

  test('requires retired identities to remain present and disabled without pinning their placement', async () => {
    const { root, snapshot, base } = await fixture();
    const historical = base.agents.find((item) => item.alias === 'heraclito')!;
    historical.enabled = true;
    historical.container_name = 'preserved-runtime-placement';
    await writeFile(snapshot, JSON.stringify(base));
    let result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('historical agent enabled: Jhon:heraclito');

    historical.enabled = false;
    base.agents = base.agents.filter((item) => item.alias !== 'heraclito');
    await writeFile(snapshot, JSON.stringify(base));
    result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('historical agent missing: Jhon:heraclito');
  });
});

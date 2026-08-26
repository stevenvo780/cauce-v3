import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = join(repository, 'ops/scripts/physical-fleet-gate.py');
const scratch: string[] = [];

async function fixture(containers: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-physical-fleet-'));
  scratch.push(root);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'container-aliases.json'), JSON.stringify({
    schemaVersion: 2,
    systemPrincipals: {},
    historicalAliases: {},
    aliases: {
      dedalo: {
        tenant: 'Pablo', room: 'grp.pablo', container: 'ws-pablo', user: 'dev',
        home: '/home/dev', stateDirectory: '/state/dedalo', harness: 'codex', membershipRole: 'agent',
        dockerHost: 'kratos', systemdUser: 'stev',
      },
      vulcano: {
        tenant: 'Pablo', room: 'grp.pablo', container: 'ws-pablo', user: 'dev',
        home: '/home/dev', stateDirectory: '/state/vulcano', harness: 'claude', membershipRole: 'agent',
        dockerHost: 'kratos', systemdUser: 'stev',
      },
      midas: {
        tenant: 'Pablo', room: 'grp.pablo', container: 'agv2-pablo-infra-oc', user: 'claw',
        home: '/home/claw', workspace: '/workspace', stateDirectory: '/state/midas',
        harness: 'openclaw', membershipRole: 'agent', dockerHost: 'kratos', systemdUser: 'stev',
      },
    },
  }));
  const snapshot = join(root, 'physical.json');
  await writeFile(snapshot, JSON.stringify({
    schemaVersion: 2,
    hosts: { kratos: containers },
  }));
  return { root, snapshot };
}

function run(root: string, snapshot: string) {
  return spawnSync('python3', [gate, '--ops-root', root, '--snapshot', snapshot], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('physical fleet pre-migration gate', () => {
  test('deduplicates shared placement and accepts every declared physical container', async () => {
    const { root, snapshot } = await fixture(['ws-pablo', 'agv2-pablo-infra-oc', 'unrelated']);
    const result = run(root, snapshot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 declared host/container placements exist across 1 hosts');
  });

  test('fails closed and names a declared container absent from the host inventory', async () => {
    const { root, snapshot } = await fixture(['ws-pablo']);
    const result = run(root, snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('declared container does not exist: kratos/agv2-pablo-infra-oc');
  });

  test('rejects malformed evidence and duplicate names', async () => {
    const { root, snapshot } = await fixture(['ws-pablo', 'ws-pablo']);
    const result = run(root, snapshot);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('duplicate container name');
  });
});

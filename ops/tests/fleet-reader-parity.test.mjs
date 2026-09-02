#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod, copyFile, mkdtemp, readFile, rename, rm, symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(ops, 'scripts');
const fixtureSnapshot = path.join(ops, 'tests/fixtures/fleet_snapshot/minimal/flota.json');

function checked(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function python(program, args, label) {
  return checked(spawnSync('python3', ['-c', program, ...args], {
    cwd: ops,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }), label);
}

function topLevelFunction(source, name) {
  const pattern = new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u');
  const match = source.match(pattern);
  assert(match, `could not isolate ${name}; its duplicated reader must remain explicitly pinned`);
  return match[0];
}

async function javascriptReader(scriptName, dependencyName, alias, inventory) {
  const source = await readFile(path.join(scripts, scriptName), 'utf8');
  const dependency = topLevelFunction(source, dependencyName);
  const target = topLevelFunction(source, 'targetFromInventory');
  const program = `
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
const alias = process.argv[1];
const here = process.cwd();
${dependency}
${target}
process.stdout.write(JSON.stringify(await targetFromInventory()));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program, alias], {
    cwd: scripts,
    encoding: 'utf8',
    env: { ...process.env, CAUCE_GATE_INVENTORY_FILE: inventory },
  });
  return JSON.parse(checked(result, `${scriptName} inventory reader for ${alias}`));
}

function canonicalFor(root) {
  return JSON.parse(python(`
import json
import pathlib
import sys

scripts_root = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(scripts_root / "scripts"))
from container_alias_lib import load_container_aliases

print(json.dumps(load_container_aliases(root), sort_keys=True))
`, [ops, root], 'container_alias_lib'));
}

function hardenedRead(root) {
  return spawnSync('python3', ['-c', `
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "scripts"))
from container_alias_lib import load_container_aliases

print(len(load_container_aliases(pathlib.Path(sys.argv[2]), hardened=True)))
`, ops, root], {
    cwd: ops,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function updatePoliciesFor(root) {
  return JSON.parse(python(`
import json
import pathlib
import sys

scripts_root = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(scripts_root / "scripts"))
from update_alias_lib import load_inventory

result = {}
for alias in sorted(json.loads((root / "container-aliases.json").read_text())["aliases"]):
    policy = load_inventory(
        root / "container-aliases.json", alias, root / "hermes-runtime.json"
    )
    result[alias] = {
        "alias": policy.alias,
        "harness": policy.harness,
        "home": policy.home,
        "stateDirectory": policy.state_directory,
        "workspace": policy.canonical_workspace,
        "requiresIsolatedConfig": policy.requires_isolated_config,
    }
print(json.dumps(result, sort_keys=True))
`, [ops, root], 'update_alias_lib'));
}

async function assertParity(root) {
  const inventory = path.join(root, 'container-aliases.json');
  const canonical = canonicalFor(root);
  const updatePolicies = updatePoliciesFor(root);

  for (const [alias, entry] of Object.entries(canonical)) {
    assert.deepEqual(
      await javascriptReader('gate-collector.mjs', 'regularJsonFile', alias, inventory),
      { tenant: entry.tenant, alias },
      `gate-collector.mjs diverged from container_alias_lib for ${alias}`,
    );
    assert.deepEqual(
      await javascriptReader('gate-roundtrip-probe.mjs', 'regularFile', alias, inventory),
      { tenant: entry.tenant, sourceRoom: 'grp.steven', alias },
      `gate-roundtrip-probe.mjs diverged from container_alias_lib for ${alias}`,
    );

    const physicalCount = Object.values(canonical).filter((candidate) => (
      candidate.container === entry.container && candidate.dockerHost === entry.dockerHost
    )).length;
    assert.deepEqual(updatePolicies[alias], {
      alias,
      harness: entry.harness,
      home: entry.home,
      stateDirectory: entry.stateDirectory,
      workspace: entry.workspace ?? null,
      requiresIsolatedConfig: physicalCount > 1 && ['claude', 'codex'].includes(entry.harness),
    }, `update_alias_lib.py diverged from container_alias_lib for ${alias}`);
  }
}

await assertParity(ops);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cauce-fleet-reader-parity-'));
try {
  const generated = spawnSync('python3', [
    path.join(scripts, 'generate-container-aliases.py'),
    '--snapshot', fixtureSnapshot,
    '--output', path.join(temporary, 'container-aliases.json'),
  ], {
    cwd: ops,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  checked(generated, 'synthetic reader inventory generation');
  await copyFile(path.join(ops, 'hermes-runtime.json'), path.join(temporary, 'hermes-runtime.json'));
  await assertParity(temporary);

  const inventory = path.join(temporary, 'container-aliases.json');
  assert.equal(hardenedRead(temporary).status, 0, 'a private inventory must pass the hardened read');

  await chmod(inventory, 0o664);
  assert.notEqual(hardenedRead(temporary).status, 0,
    'the hardened read must reject a group-writable inventory');
  assert.ok(Object.keys(canonicalFor(temporary)).length > 0,
    'the hardening is opt-in: the default read must still accept the same inventory');

  await chmod(inventory, 0o644);
  const target = path.join(temporary, 'real-container-aliases.json');
  await rename(inventory, target);
  await symlink(target, inventory);
  assert.notEqual(hardenedRead(temporary).status, 0,
    'the hardened read must refuse to follow a symlinked inventory');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('fleet reader parity tests passed\n');

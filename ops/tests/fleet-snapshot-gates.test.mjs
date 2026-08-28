#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access, copyFile, mkdir, mkdtemp, readFile, readdir, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(ops, 'scripts');
const fixtureRoot = path.join(ops, 'tests/fixtures/fleet_snapshot/minimal');
const fixtureSnapshotPath = path.join(fixtureRoot, 'flota.json');
const fixtureOverlayPath = path.join(fixtureRoot, 'flota-fisica.json');
const allowedPlacementKeys = new Set([
  'dockerHost', 'healthContainer', 'registryContainer',
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected or missing keys`);
}

function validateOverlay(snapshot, overlay) {
  exactKeys(overlay, ['placement', 'schemaVersion'], 'physical fleet overlay');
  assert.equal(overlay.schemaVersion, 1, 'physical fleet overlay must use schemaVersion 1');
  assert(snapshot.fleet && typeof snapshot.fleet === 'object' && !Array.isArray(snapshot.fleet),
    'fleet snapshot must contain a fleet object');
  assert(snapshot.placement && typeof snapshot.placement === 'object' && !Array.isArray(snapshot.placement),
    'fleet snapshot must contain a placement object');
  assert(overlay.placement && typeof overlay.placement === 'object' && !Array.isArray(overlay.placement),
    'physical fleet placement must be an object');

  for (const [alias, placement] of Object.entries(overlay.placement)) {
    assert(Object.hasOwn(snapshot.fleet, alias),
      `physical fleet alias ${alias} is absent from the active snapshot fleet`);
    assert(placement && typeof placement === 'object' && !Array.isArray(placement),
      `physical fleet placement for ${alias} must be an object`);
    const keys = Object.keys(placement);
    assert(keys.length > 0, `physical fleet placement for ${alias} is empty and redundant`);
    for (const key of keys) {
      assert(allowedPlacementKeys.has(key),
        `physical fleet placement for ${alias} has forbidden key ${key}`);
      assert.equal(typeof placement[key], 'string',
        `physical fleet placement ${alias}.${key} must be a string`);
      assert(placement[key].length > 0,
        `physical fleet placement ${alias}.${key} must not be empty`);
    }

    const fleetContainer = snapshot.fleet[alias].container;
    const healthContainer = placement.healthContainer ?? fleetContainer;
    assert.notEqual(placement.dockerHost, 'local',
      `physical fleet placement ${alias}.dockerHost repeats its default`);
    assert.notEqual(placement.healthContainer, fleetContainer,
      `physical fleet placement ${alias}.healthContainer repeats its default`);
    assert.notEqual(placement.registryContainer, healthContainer,
      `physical fleet placement ${alias}.registryContainer repeats its default`);
  }
  assert.deepEqual(overlay.placement, snapshot.placement,
    'physical fleet overlay must equal the placement embedded in the canonical snapshot');
}

function runPython(script, args, label) {
  const result = spawnSync('python3', [script, ...args], {
    cwd: ops,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr}`);
}

async function manifestBytes(directory) {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => (
    [name, (await readFile(path.join(directory, name))).toString('base64')]
  ))));
}

async function generate(outputRoot) {
  const aliases = path.join(outputRoot, 'container-aliases.json');
  const manifests = path.join(outputRoot, 'manifests');
  const runtimeFleet = path.join(outputRoot, 'fleet.json');
  await mkdir(manifests, { recursive: true });
  runPython(path.join(scripts, 'generate-container-aliases.py'), [
    '--snapshot', fixtureSnapshotPath, '--output', aliases,
  ], 'container alias generator');
  runPython(path.join(scripts, 'generate-manifests.py'), [
    '--snapshot', fixtureSnapshotPath, '--output', manifests,
  ], 'manifest generator');
  runPython(path.join(scripts, 'generate-runtime-fleet.py'), [
    '--snapshot', fixtureSnapshotPath, '--output', runtimeFleet,
  ], 'runtime fleet generator');
  return {
    aliases: await readFile(aliases),
    manifests: await manifestBytes(manifests),
    runtimeFleet: await readFile(runtimeFleet),
  };
}

const fixtureSnapshot = await readJson(fixtureSnapshotPath);
const fixtureOverlay = await readJson(fixtureOverlayPath);
validateOverlay(fixtureSnapshot, fixtureOverlay);

for (const [mutate, expected] of [
  [(overlay) => { overlay.placement['unknown-alias'] = { dockerHost: 'kratos' }; }, /absent/u],
  [(overlay) => { overlay.placement['fixture-hermes'].unknown = 'value'; }, /forbidden key/u],
  [(overlay) => { overlay.placement['fixture-hermes'].dockerHost = 'local'; }, /dockerHost repeats/u],
  [(overlay) => { overlay.placement['fixture-hermes'].healthContainer = 'fixture-hermes-runtime'; }, /healthContainer repeats/u],
  [(overlay) => { overlay.placement['fixture-hermes'].registryContainer = 'fixture-hermes-runtime'; }, /registryContainer repeats/u],
  [(overlay) => { overlay.placement['fixture-codex'].registryContainer = 'fixture-health'; }, /registryContainer repeats/u],
  [(overlay) => { overlay.placement['fixture-hermes'] = {}; }, /empty and redundant/u],
]) {
  const invalid = structuredClone(fixtureOverlay);
  mutate(invalid);
  assert.throws(() => validateOverlay(fixtureSnapshot, invalid), expected);
}

const liveSnapshotPath = path.join(ops, 'flota.json');
let liveSnapshotExists = false;
try {
  await access(liveSnapshotPath);
  liveSnapshotExists = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (liveSnapshotExists) {
  validateOverlay(
    await readJson(liveSnapshotPath),
    await readJson(path.join(ops, 'flota-fisica.json')),
  );
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'cauce-fleet-snapshot-gates-'));
try {
  const outputRoot = path.join(temporary, 'generated');
  const first = await generate(outputRoot);
  const second = await generate(outputRoot);
  assert.deepEqual(second, first, 'fleet generators must be byte-idempotent on a fixed snapshot');

  await mkdir(path.join(outputRoot, 'schemas'));
  await copyFile(
    path.join(ops, 'schemas/alias-manifest.schema.json'),
    path.join(outputRoot, 'schemas/alias-manifest.schema.json'),
  );
  const validation = spawnSync('python3', ['-c', `
import json
import pathlib
import sys

ops, generated = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(ops / "scripts"))
from container_alias_lib import load_container_aliases, load_system_principals
from manifest_lib import load_manifests

aliases = load_container_aliases(generated)
principals = load_system_principals(generated)
manifests = load_manifests(generated)
assert len(aliases) == 3
assert len(principals) == 1
assert len(manifests) == 3
`, ops, outputRoot], {
    cwd: ops,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(validation.status, 0,
    `generated fleet artifacts were rejected by the canonical libraries:\n${validation.stderr}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('fleet snapshot gate tests passed\n');

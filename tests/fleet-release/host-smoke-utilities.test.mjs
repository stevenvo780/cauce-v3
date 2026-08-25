import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateHostEvidence } from './aggregate-host-smoke.mjs';
import { readFleetManifests, validateFleetMatrix } from './manifest-matrix.mjs';
import { runHostSmoke } from './host-smoke.mjs';

const temporaryDirectories = [];
const manifestDirectory = path.resolve('ops/manifests');
const sourceDigest = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function evidence(host, manifests) {
  const harnesses = [...new Set(manifests.map((manifest) => manifest.harness))];
  return {
    schemaVersion: 1,
    suite: 'cauce-v3-host-harness-smoke',
    sourceDigest,
    host,
    manifests: manifests.map((manifest) => ({
      alias: manifest.alias,
      harness: manifest.harness,
      path: manifest.path,
      sha256: manifest.sha256,
    })),
    checks: harnesses.map((harness) => ({
      harness,
      status: 'passed',
      evidenceClass: 'harness-authentic',
      binarySha256: 'a'.repeat(64),
    })),
  };
}

describe('host-aware harness smoke utilities', () => {
  it('requires the exact 15-alias 5/3/1/6/0 manifest matrix', async () => {
    const manifests = await readFleetManifests(manifestDirectory);
    expect(validateFleetMatrix(manifests).counts).toEqual({
      openclaw: 5,
      claude: 3,
      hermes: 1,
      codex: 6,
      opencode: 0,
    });
    expect(() => validateFleetMatrix(manifests.slice(1))).toThrow(/exactly 15/u);
  });

  it('does not require OpenClaw on control-plane when OpenClaw manifests live elsewhere', async () => {
    const manifests = await readFleetManifests(manifestDirectory);
    const controlPlane = manifests.filter((manifest) => manifest.harness !== 'openclaw');
    const openClaw = manifests.filter((manifest) => manifest.harness === 'openclaw');
    const edgeA = openClaw.slice(0, 2);
    const edgeB = openClaw.slice(2);
    const inventory = {
      schemaVersion: 1,
      controlPlaneHost: 'control-plane',
      hosts: {
        'control-plane': controlPlane.map((manifest) => manifest.path),
        'adapter-a': edgeA.map((manifest) => manifest.path),
        'adapter-b': edgeB.map((manifest) => manifest.path),
      },
    };
    const report = await aggregateHostEvidence({
      inventory,
      sourceDigest,
      evidenceByHost: {
        'control-plane': evidence('control-plane', controlPlane),
        'adapter-a': evidence('adapter-a', edgeA),
        'adapter-b': evidence('adapter-b', edgeB),
      },
    });
    expect(report.summary.failed).toBe(0);
    expect(report.fleet.controlPlaneOpenClawRequired).toBe(false);
    expect(report.fleet.openClawEvidenceHosts).toEqual(['adapter-a', 'adapter-b']);
  });

  it('fails when a host assigned OpenClaw manifests omits authentic OpenClaw evidence', async () => {
    const manifests = await readFleetManifests(manifestDirectory);
    const controlPlane = manifests.filter((manifest) => manifest.harness !== 'openclaw');
    const edge = manifests.filter((manifest) => manifest.harness === 'openclaw');
    const edgeEvidence = evidence('adapter-edge', edge);
    edgeEvidence.checks = [];
    const report = await aggregateHostEvidence({
      inventory: {
        schemaVersion: 1,
        controlPlaneHost: 'control-plane',
        hosts: {
          'control-plane': controlPlane.map((manifest) => manifest.path),
          'adapter-edge': edge.map((manifest) => manifest.path),
        },
      },
      sourceDigest,
      evidenceByHost: {
        'control-plane': evidence('control-plane', controlPlane),
        'adapter-edge': edgeEvidence,
      },
    });
    expect(report.summary.failed).toBe(1);
    expect(report.violations).toContain('adapter-edge: openclaw --version/--help evidence is missing');
  });

  it('runs version/help with an isolated environment and records only bounded digests', async () => {
    const directory = await mkdtemp(path.resolve('tests/fleet-release/.host-smoke-test-'));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, 'codex-fixture');
    await writeFile(executable, '#!/bin/sh\n[ "$1" = "--version" ] && printf "fixture 1\\n" && exit 0\n[ "$1" = "--help" ] && printf "fixture help\\n" && exit 0\nexit 2\n');
    await chmod(executable, 0o700);
    const report = await runHostSmoke({
      host: 'test-host',
      manifestPaths: [path.join(manifestDirectory, 'kant.yaml')],
      commands: { codex: executable },
      searchPath: '/usr/bin:/bin',
      evidenceClass: 'harness-double',
      sourceDigest,
    });
    expect(report.summary).toEqual({ checks: 1, passed: 1, failed: 0 });
    expect(report.checks[0]).toMatchObject({
      harness: 'codex',
      status: 'passed',
      evidenceClass: 'harness-double',
    });
    expect(report.checks[0]).not.toHaveProperty('output');
  });
});

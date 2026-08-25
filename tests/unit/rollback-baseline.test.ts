import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'ops/scripts/rollback-baseline.py');
const bridgeSchema: unknown = JSON.parse(await readFile(
  join(repository, 'ops/schemas/rollback-bridge.schema.json'), 'utf8',
));
const operations = spawnSync(
  'python3', [join(repository, 'ops/scripts/container_ops_digest.py')], { encoding: 'utf8' },
).stdout.trim();
const bridgeRef = `registry.invalid/cauce/runtime-bridge@sha256:${'a'.repeat(64)}`;
const bridgeId = `sha256:${'b'.repeat(64)}`;
const candidateRef = `registry.invalid/cauce/runtime@sha256:${'c'.repeat(64)}`;
const candidateId = `sha256:${'d'.repeat(64)}`;
const consoleRef = `registry.invalid/cauce/console@sha256:${'e'.repeat(64)}`;
const consoleId = `sha256:${'f'.repeat(64)}`;
const candidateSource = `sha256:${'9'.repeat(64)}`;
const patchText = 'synthetic rollback bridge patch\n';
const scratch: string[] = [];

type FleetDefinitionName = 'enabledAgents' | 'enabledMemberships' | 'disabledHistoricalAgents';

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireProperty(value: unknown, property: string, path: string): unknown {
  const record = requireRecord(value, path);
  if (!(property in record)) {
    throw new Error(`${path}.${property} is required`);
  }
  return record[property];
}

function schemaValue(path: readonly string[]): unknown {
  let value = bridgeSchema;
  let traversed = 'rollback bridge schema';
  for (const property of path) {
    value = requireProperty(value, property, traversed);
    traversed = `${traversed}.${property}`;
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function schemaConst(path: readonly string[]): string {
  return requireString(schemaValue(path), `rollback bridge schema.${path.join('.')}`);
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function constants(name: FleetDefinitionName): string[] {
  const path = ['$defs', name, 'prefixItems'] as const;
  const entries = schemaValue(path);
  if (!Array.isArray(entries)) {
    throw new Error(`rollback bridge schema.${path.join('.')} must be an array`);
  }
  return entries.map((entry, index) => requireString(
    requireProperty(entry, 'const', `rollback bridge schema.${path.join('.')}[${index}]`),
    `rollback bridge schema.${path.join('.')}[${index}].const`,
  ));
}

function bridgeReport() {
  const generated = new Date(Date.now() - 60_000);
  const validUntil = new Date(generated.getTime() + 24 * 60 * 60_000);
  const state = {
    migrationLedgerSha256: `sha256:${'1'.repeat(64)}`,
    reconciliationSha256: `sha256:${'2'.repeat(64)}`,
    profileContentSha256: `sha256:${'3'.repeat(64)}`,
    profileRevisionSha256: `sha256:${'4'.repeat(64)}`,
    leasesSha256: `sha256:${'5'.repeat(64)}`,
  };
  const test = (name: string, mechanism: string) => ({ name, mechanism, status: 'passed', critical: true });
  return {
    schemaVersion: 2,
    suite: 'cauce-v3-rollback-bridge',
    evidenceClass: 'rollback-bridge',
    mechanism: 'isolated-restored-production-backup-runtime-image-cycle',
    generatedAt: generated.toISOString(),
    validUntil: validUntil.toISOString(),
    sourceDigest: `sha256:${'6'.repeat(64)}`,
    sourceDigestDomain: 'runtime',
    operationsDigest: operations,
    dockerfileSha256: `sha256:${'7'.repeat(64)}`,
    sourceRevision: {
      originBaseCommit: '1'.repeat(40), patchSourceCommit: '2'.repeat(40),
      patchPath: 'ops/rollback-bridge/rollback-bridge-schema029.patch', resultingBridgeTree: '3'.repeat(40),
      patchSetSha256: digest(patchText), worktreeStatus: 'clean', buildContext: 'git-archive',
    },
    runtime: {
      bridgeKind: 'origin-main-plus-schema029-shims', repositoryDigest: bridgeRef,
      imageId: bridgeId, sourceDigest: `sha256:${'6'.repeat(64)}`, sourceDigestDomain: 'runtime',
    },
    candidateRuntime: {
      repositoryDigest: candidateRef, imageId: candidateId,
      sourceDigest: candidateSource, sourceDigestDomain: 'runtime',
    },
    database: {
      restoreEvidenceSha256: `sha256:${'a'.repeat(64)}`,
      restoredBackupSha256: `sha256:${'b'.repeat(64)}`,
      postgresMajor: 16, schemaLatest: '029_reconcile_declared_fleet.sql', isolated: true,
      network: 'private-test-network', egress: 'disabled', productionConnected: false,
      snapshots: [
        { stage: 'candidate-after-migrate-029', ...state },
        { stage: 'bridge-after-noop-migrator-and-tests', ...state },
        { stage: 'candidate-after-return-noop-migrator-and-model-free-ack', ...state },
        { stage: 'candidate-before-injected-rollback-failure', ...state },
        { stage: 'candidate-after-rollback-compensation', ...state },
      ],
    },
    digestContract: {
      algorithm: 'sha256', encoding: 'canonical-json-utf8',
      migrationLedger: schemaConst([
        'properties', 'digestContract', 'properties', 'migrationLedger', 'const',
      ]),
      reconciliation: schemaConst([
        'properties', 'digestContract', 'properties', 'reconciliation', 'const',
      ]),
      leases: schemaConst(['properties', 'digestContract', 'properties', 'leases', 'const']),
    },
    fleet: {
      enabledAgentCount: 15, enabledAgents: constants('enabledAgents'),
      enabledMembershipCount: 16, enabledMemberships: constants('enabledMemberships'),
      disabledHistoricalAgentCount: 3, disabledHistoricalAgents: constants('disabledHistoricalAgents'),
      systemPrincipalAgentRowCount: 0, gateProbeMembershipCount: 0,
      quotaCollectorEnabledMembershipCount: 1,
      agentNotifyRole: { allowRoute: true, allowRead: true, allowControl: false, allowNotify: true },
      activeReconciliationRunCount: 1,
      activeReconciliationMigration: '029_reconcile_declared_fleet.sql',
    },
    lifecycle: {
      candidateInitial: {
        preMigrationIntegrity: 'passed', migratedThrough: '029_reconcile_declared_fleet.sql',
        postMigrationIntegrity: 'passed',
      },
      bridge: {
        allWritersDrained: true, migratorResult: 'no-op', centralServicesOnly: true,
        disabledExternalComponents: ['adapters', 'models', 'telegram'], health: 'passed',
      },
      candidateReturn: {
        bridgeDrained: true, migratorResult: 'no-op', health: 'passed',
        modelFreeRoundtrip: 'publish-claim-ack', status: 'passed',
      },
      compensation: {
        rollbackAction: 'release', failureInjection: 'post-selector-swap-health', failureObserved: true,
        selectorCasRestored: true, candidateImageRestored: true, servicesRestored: true,
        databaseDigestsUnchanged: true, status: 'passed',
      },
    },
    shims: [
      'profile-role-writes-frozen', 'unrelated-agent-update-omits-role-brief',
      'system-principals-filtered', 'gate-probe-explicitly-rejected',
    ],
    tests: [
      test('profile-role-writes-frozen', 'mutation-rejected'),
      test('unrelated-agent-update-preserves-role', 'database-state-comparison'),
      test('system-principals-filtered', 'read-model-contract'),
      test('gate-probe-explicitly-rejected', 'protocol-negative'),
      test('basic-read-delivery-compatible', 'runtime-integration'),
      test('schema029-fleet-exact', 'database-exact-set'),
      test('agent-notify-role-exact', 'application-role-policy'),
      test('migration-ledger-and-reconciliation-noop', 'canonical-state-digest'),
      test('connection-leases-preserved', 'canonical-state-digest'),
      test('candidate-return-model-free-roundtrip', 'publish-claim-ack'),
      test('rollback-health-failure-compensates', 'rollback-script-injected-failure'),
    ],
    summary: { tests: 11, passed: 11, failed: 0, skipped: 0, criticalSkipped: 0 },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-baseline-'));
  scratch.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const docker = join(bin, 'docker');
  await writeFile(docker, `#!/bin/sh
set -eu
if [ "$1" = pull ]; then exit 0; fi
last=
for value in "$@"; do last=$value; done
case " $* " in
  *'{{json .RepoDigests}}'*) printf '["%s"]\n' "$last" ;;
  *'{{.Id}}'*)
    case "$last" in
      "$FAKE_BRIDGE_REF") printf '%s\n' "$FAKE_BRIDGE_ID" ;;
      "$FAKE_CANDIDATE_REF") printf '%s\n' "$FAKE_CANDIDATE_ID" ;;
      "$FAKE_CONSOLE_REF") printf '%s\n' "$FAKE_CONSOLE_ID" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await chmod(docker, 0o755);
  const git = join(bin, 'git');
  await writeFile(git, `#!/bin/sh
set -eu
case " $* " in
  *' cat-file -e '*|*' merge-base --is-ancestor '*|*' read-tree '*|*' apply --cached '*) cat >/dev/null || true; exit 0 ;;
  *' show '*) printf '%s' "$FAKE_PATCH" ;;
  *' write-tree'*) printf '%s\n' "$FAKE_TREE" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await chmod(git, 0o755);
  const evidence = join(directory, 'rollback-bridge.json');
  const evidenceText = `${JSON.stringify(bridgeReport(), null, 2)}\n`;
  await writeFile(evidence, evidenceText, { mode: 0o600 });
  await chmod(evidence, 0o600);
  const manifest = join(directory, 'previous.manifest');
  await writeFile(manifest, `inactive ${'0'.repeat(64)} legacy.yaml\n`, { mode: 0o600 });
  await chmod(manifest, 0o600);
  const output = join(directory, 'rollback-baseline.json');
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_BRIDGE_REF: bridgeRef,
    FAKE_BRIDGE_ID: bridgeId,
    FAKE_CANDIDATE_REF: candidateRef,
    FAKE_CANDIDATE_ID: candidateId,
    FAKE_CONSOLE_REF: consoleRef,
    FAKE_CONSOLE_ID: consoleId,
    FAKE_PATCH: patchText,
    FAKE_TREE: '3'.repeat(40),
  };
  return { directory, evidence, evidenceSha: digest(evidenceText), manifest, output, environment };
}

function createArgs(value: Awaited<ReturnType<typeof fixture>>): string[] {
  return [
    helper, 'create', '--output', value.output, '--forward-release-commit', 'f'.repeat(40),
    '--forward-runtime-image', candidateRef, '--bridge-runtime-image', bridgeRef,
    '--forward-runtime-source-digest', candidateSource,
    '--console-image', consoleRef, '--override-manifest', value.manifest,
    '--bridge-evidence', value.evidence, '--bridge-evidence-sha256', value.evidenceSha,
  ];
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('durable rollback baseline', () => {
  test('publishes once at mode 0600 and validates both registry images and exact bridge evidence', async () => {
    const value = await fixture();
    const created = spawnSync('python3', createArgs(value), { encoding: 'utf8', env: value.environment });
    expect(created.status, created.stderr).toBe(0);
    const baselineSha = created.stdout.trim();
    expect(baselineSha).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect((await stat(value.output)).mode & 0o777).toBe(0o600);
    const checked = spawnSync('python3', [
      helper, 'check', '--baseline', value.output, '--expected-baseline-sha256', baselineSha,
      '--expected-forward-release-commit', 'f'.repeat(40),
      '--expected-forward-runtime-image', candidateRef,
      '--expected-forward-runtime-image-id', candidateId,
      '--expected-forward-runtime-source-digest', candidateSource,
      '--expected-runtime-image', bridgeRef, '--expected-console-image', consoleRef,
      '--expected-override-manifest', value.manifest,
      '--expected-bridge-evidence', value.evidence,
      '--expected-bridge-evidence-sha256', value.evidenceSha,
    ], { encoding: 'utf8', env: value.environment });
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toBe('rollback baseline passed\n');
    const field = spawnSync('python3', [
      helper, 'field', '--baseline', value.output, '--expected-baseline-sha256', baselineSha,
      '--name', 'bridge-runtime-image',
    ], { encoding: 'utf8', env: value.environment });
    expect(field.stdout).toBe(`${bridgeRef}\n`);
    expect(spawnSync('python3', createArgs(value), { encoding: 'utf8', env: value.environment }).status).toBe(1);
  });

  test('fails closed on hash, registry ID, manifest, and permission drift', async () => {
    const value = await fixture();
    const created = spawnSync('python3', createArgs(value), { encoding: 'utf8', env: value.environment });
    expect(created.status, created.stderr).toBe(0);
    const baselineSha = created.stdout.trim();
    const check = () => spawnSync('python3', [
      helper, 'check', '--baseline', value.output, '--expected-baseline-sha256', baselineSha,
    ], { encoding: 'utf8', env: value.environment });

    expect(spawnSync('python3', [
      helper, 'check', '--baseline', value.output,
      '--expected-baseline-sha256', `sha256:${'0'.repeat(64)}`,
    ], { encoding: 'utf8', env: value.environment }).status).toBe(1);
    value.environment.FAKE_CONSOLE_ID = `sha256:${'0'.repeat(64)}`;
    expect(check().status).toBe(1);
    value.environment.FAKE_CONSOLE_ID = consoleId;
    await writeFile(value.manifest, 'mutated\n');
    expect(check().status).toBe(1);
    await chmod(value.output, 0o640);
    expect(check().status).toBe(1);
    expect(await readFile(value.output, 'utf8')).not.toContain('SENTINEL_SECRET');
  });
});

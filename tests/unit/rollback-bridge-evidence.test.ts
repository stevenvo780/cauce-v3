import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const validator = join(repository, 'ops/scripts/validate-rollback-bridge-evidence.py');
const operations = spawnSync(
  'python3', [join(repository, 'ops/scripts/container_ops_digest.py')], { encoding: 'utf8' },
).stdout.trim();
const runtimeRef = `registry.invalid/cauce/runtime-bridge@sha256:${'a'.repeat(64)}`;
const runtimeId = `sha256:${'b'.repeat(64)}`;
const candidateRef = `registry.invalid/cauce/runtime@sha256:${'e'.repeat(64)}`;
const candidateId = `sha256:${'f'.repeat(64)}`;
const candidateSource = `sha256:${'0'.repeat(64)}`;
const patchText = 'synthetic rollback bridge patch\n';
const scratch: string[] = [];

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function report() {
  const generated = new Date(Date.now() - 60_000);
  const validUntil = new Date(generated.getTime() + 24 * 60 * 60_000);
  const source = `sha256:${'c'.repeat(64)}`;
  const snapshot = {
    migrationLedgerSha256: `sha256:${'5'.repeat(64)}`,
    reconciliationSha256: `sha256:${'6'.repeat(64)}`,
    profileContentSha256: `sha256:${'7'.repeat(64)}`,
    profileRevisionSha256: `sha256:${'8'.repeat(64)}`,
    leasesSha256: `sha256:${'9'.repeat(64)}`,
  };
  return {
    schemaVersion: 2,
    suite: 'cauce-v3-rollback-bridge',
    evidenceClass: 'rollback-bridge',
    mechanism: 'isolated-restored-production-backup-runtime-image-cycle',
    generatedAt: generated.toISOString(),
    validUntil: validUntil.toISOString(),
    sourceDigest: source,
    sourceDigestDomain: 'runtime',
    operationsDigest: operations,
    dockerfileSha256: `sha256:${'d'.repeat(64)}`,
    sourceRevision: {
      originBaseCommit: '1'.repeat(40),
      patchSourceCommit: '2'.repeat(40),
      patchPath: 'ops/rollback-bridge/rollback-bridge-schema029.patch',
      resultingBridgeTree: '3'.repeat(40),
      patchSetSha256: digest(patchText),
      worktreeStatus: 'clean',
      buildContext: 'git-archive',
    },
    runtime: {
      bridgeKind: 'origin-main-plus-schema029-shims',
      repositoryDigest: runtimeRef,
      imageId: runtimeId,
      sourceDigest: source,
      sourceDigestDomain: 'runtime',
    },
    candidateRuntime: {
      repositoryDigest: candidateRef,
      imageId: candidateId,
      sourceDigest: candidateSource,
      sourceDigestDomain: 'runtime',
    },
    database: {
      restoreEvidenceSha256: `sha256:${'8'.repeat(64)}`,
      restoredBackupSha256: `sha256:${'9'.repeat(64)}`,
      postgresMajor: 16,
      schemaLatest: '029_reconcile_declared_fleet.sql',
      isolated: true,
      network: 'private-test-network',
      egress: 'disabled',
      productionConnected: false,
      snapshots: [
        { stage: 'candidate-after-migrate-029', ...snapshot },
        { stage: 'bridge-after-noop-migrator-and-tests', ...snapshot },
        { stage: 'candidate-after-return-noop-migrator-and-model-free-ack', ...snapshot },
        { stage: 'candidate-before-injected-rollback-failure', ...snapshot },
        { stage: 'candidate-after-rollback-compensation', ...snapshot },
      ],
    },
    digestContract: {
      algorithm: 'sha256',
      encoding: 'canonical-json-utf8',
      migrationLedger: 'schema_migrations(version,applied_at)|schema_migration_ledger(version,source_sha256,source_origin,recorded_at)|schema_migration_verifications(version,bundled_source_sha256,observed_schema_sha256,verification_method,source_origin,verified_at);all-rows;tables-listed-order;rows-primary-key-order',
      reconciliation: 'fleet_reconciliation_runs(id,migration_version,active,applied_at,rolled_back_at)|fleet_reconciliation_history(run_id,entity,tenant_id,alias,room_id,previous,applied,captured_at);all-rows;tables-listed-order;rows-primary-key-order',
      leases: 'connection_leases(tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at);capabilities-jsonb;all-rows;rows-tenant_id-alias-order',
    },
    fleet: {
      enabledAgentCount: 15,
      enabledAgents: [
        'Isa:salva', 'Jhon:hegel', 'Miguel:atlas', 'Miguel:iza', 'Miguel:janus',
        'Miguel:kratos', 'Pablo:dedalo', 'Pablo:midas', 'Pablo:seneca', 'Pablo:vulcano',
        'Steven:argos', 'Steven:jarvis', 'Steven:kant', 'Steven:socrates', 'Steven:zeus',
      ],
      enabledMembershipCount: 16,
      enabledMemberships: [
        'Isa:salva:grp.isa:agent', 'Jhon:hegel:grp.jhon:agent',
        'Miguel:atlas:grp.miguel:agent', 'Miguel:iza:grp.miguel:agent',
        'Miguel:janus:grp.miguel:operator', 'Miguel:kratos:grp.miguel:agent',
        'Pablo:dedalo:grp.pablo:agent', 'Pablo:midas:grp.pablo:agent',
        'Pablo:seneca:grp.pablo:agent', 'Pablo:vulcano:grp.pablo:agent',
        'Steven:argos:grp.steven:agent', 'Steven:jarvis:grp.steven:agent_notify',
        'Steven:kant:grp.steven:operator', 'Steven:quota-collector:grp.steven:operator',
        'Steven:socrates:grp.steven:agent_notify', 'Steven:zeus:grp.steven:agent_notify',
      ],
      disabledHistoricalAgentCount: 3,
      disabledHistoricalAgents: ['Jhon:heraclito', 'Jhon:tales', 'Miguel:gaia'],
      systemPrincipalAgentRowCount: 0,
      gateProbeMembershipCount: 0,
      quotaCollectorEnabledMembershipCount: 1,
      agentNotifyRole: { allowRoute: true, allowRead: true, allowControl: false, allowNotify: true },
      activeReconciliationRunCount: 1,
      activeReconciliationMigration: '029_reconcile_declared_fleet.sql',
    },
    lifecycle: {
      candidateInitial: {
        preMigrationIntegrity: 'passed',
        migratedThrough: '029_reconcile_declared_fleet.sql',
        postMigrationIntegrity: 'passed',
      },
      bridge: {
        allWritersDrained: true,
        migratorResult: 'no-op',
        centralServicesOnly: true,
        disabledExternalComponents: ['adapters', 'models', 'telegram'],
        health: 'passed',
      },
      candidateReturn: {
        bridgeDrained: true,
        migratorResult: 'no-op',
        health: 'passed',
        modelFreeRoundtrip: 'publish-claim-ack',
        status: 'passed',
      },
      compensation: {
        rollbackAction: 'release',
        failureInjection: 'post-selector-swap-health',
        failureObserved: true,
        selectorCasRestored: true,
        candidateImageRestored: true,
        servicesRestored: true,
        databaseDigestsUnchanged: true,
        status: 'passed',
      },
    },
    shims: [
      'profile-role-writes-frozen',
      'unrelated-agent-update-omits-role-brief',
      'system-principals-filtered',
      'gate-probe-explicitly-rejected',
    ],
    tests: [
      { name: 'profile-role-writes-frozen', mechanism: 'mutation-rejected', status: 'passed', critical: true },
      { name: 'unrelated-agent-update-preserves-role', mechanism: 'database-state-comparison', status: 'passed', critical: true },
      { name: 'system-principals-filtered', mechanism: 'read-model-contract', status: 'passed', critical: true },
      { name: 'gate-probe-explicitly-rejected', mechanism: 'protocol-negative', status: 'passed', critical: true },
      { name: 'basic-read-delivery-compatible', mechanism: 'runtime-integration', status: 'passed', critical: true },
      { name: 'schema029-fleet-exact', mechanism: 'database-exact-set', status: 'passed', critical: true },
      { name: 'agent-notify-role-exact', mechanism: 'application-role-policy', status: 'passed', critical: true },
      { name: 'migration-ledger-and-reconciliation-noop', mechanism: 'canonical-state-digest', status: 'passed', critical: true },
      { name: 'connection-leases-preserved', mechanism: 'canonical-state-digest', status: 'passed', critical: true },
      { name: 'candidate-return-model-free-roundtrip', mechanism: 'publish-claim-ack', status: 'passed', critical: true },
      { name: 'rollback-health-failure-compensates', mechanism: 'rollback-script-injected-failure', status: 'passed', critical: true },
    ],
    summary: { tests: 11, passed: 11, failed: 0, skipped: 0, criticalSkipped: 0 },
  };
}

async function fixture(payload = report()) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-rollback-bridge-'));
  scratch.push(directory);
  const evidence = join(directory, 'rollback-bridge.json');
  const bin = join(directory, 'bin');
  await mkdir(bin);
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
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(evidence, text, { mode: 0o600 });
  await chmod(evidence, 0o600);
  return {
    evidence,
    sha256: digest(text),
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_PATCH: patchText,
      FAKE_TREE: '3'.repeat(40),
    },
  };
}

function run(
  evidence: string,
  sha256: string,
  image = runtimeRef,
  id = runtimeId,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync('python3', [
    validator,
    '--evidence', evidence,
    '--expected-evidence-sha256', sha256,
    '--expected-repository-digest', image,
    '--expected-image-id', id,
    '--expected-candidate-repository-digest', candidateRef,
    '--expected-candidate-image-id', candidateId,
    '--expected-candidate-source-digest', candidateSource,
  ], { encoding: 'utf8', env: environment });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('rollback bridge evidence gate', () => {
  test('accepts only the exact current operations, RepoDigest, recovered ID, and five passing proofs', async () => {
    const value = await fixture();
    const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('rollback bridge evidence passed\n');
  });

  test('rejects mutation, profile/revision drift, stale evidence, and another recovered image', async () => {
    const value = await fixture();
    expect(run(value.evidence, `sha256:${'0'.repeat(64)}`, runtimeRef, runtimeId, value.environment).status).toBe(1);
    expect(run(value.evidence, value.sha256, runtimeRef, `sha256:${'0'.repeat(64)}`, value.environment).status).toBe(1);

    const changed = report();
    const bridgeSnapshot = changed.database.snapshots.at(1);
    if (!bridgeSnapshot) throw new Error('rollback bridge fixture is missing its bridge snapshot');
    bridgeSnapshot.profileContentSha256 = `sha256:${'4'.repeat(64)}`;
    const changedValue = await fixture(changed);
    const changedResult = run(changedValue.evidence, changedValue.sha256, runtimeRef, runtimeId, changedValue.environment);
    expect(changedResult.status).toBe(1);
    expect(changedResult.stderr).toContain('changed canonical profile content');

    const stale = report();
    stale.generatedAt = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    stale.validUntil = new Date(Date.now() - 9 * 24 * 60 * 60_000).toISOString();
    const staleValue = await fixture(stale);
    expect(run(staleValue.evidence, staleValue.sha256, runtimeRef, runtimeId, staleValue.environment).status).toBe(1);
  });

  test('fails closed on broad permissions without printing evidence contents', async () => {
    const value = await fixture();
    await chmod(value.evidence, 0o640);
    const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(runtimeRef);
    expect(await readFile(value.evidence, 'utf8')).toContain('profile-role-writes-frozen');
  });
});

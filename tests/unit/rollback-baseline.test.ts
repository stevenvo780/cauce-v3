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
const composeSha256 = digest(await readFile(join(repository, 'ops/compose.rollback-bridge.yaml')));
const bridgeMetadata: unknown = JSON.parse(await readFile(
  join(repository, 'ops/rollback-bridge/metadata.json'), 'utf8',
));
const bridgeBase = requireString(requireProperty(
  requireProperty(bridgeMetadata, 'imagePublication', 'bridge metadata'),
  'pinnedNodeBaseRepositoryDigest', 'bridge metadata.imagePublication',
), 'bridge metadata.imagePublication.pinnedNodeBaseRepositoryDigest');
const bridgePythonBase = requireString(requireProperty(
  requireProperty(bridgeMetadata, 'imagePublication', 'bridge metadata'),
  'pinnedPythonBaseRepositoryDigest', 'bridge metadata.imagePublication',
), 'bridge metadata.imagePublication.pinnedPythonBaseRepositoryDigest');
const originBaseCommit = requireString(
  requireProperty(bridgeMetadata, 'originBaseCommit', 'bridge metadata'),
  'bridge metadata.originBaseCommit',
);
const patchPath = requireString(
  requireProperty(bridgeMetadata, 'patchPath', 'bridge metadata'), 'bridge metadata.patchPath',
);
const resultingBridgeTree = requireString(
  requireProperty(bridgeMetadata, 'resultingBridgeTree', 'bridge metadata'),
  'bridge metadata.resultingBridgeTree',
);
const patchSetSha256 = requireString(
  requireProperty(bridgeMetadata, 'patchSetSha256', 'bridge metadata'), 'bridge metadata.patchSetSha256',
);
const bridgeRef = `registry.invalid/cauce/runtime-bridge@sha256:${'a'.repeat(64)}`;
const bridgeId = `sha256:${'b'.repeat(64)}`;
const candidateRef = `registry.invalid/cauce/runtime@sha256:${'c'.repeat(64)}`;
const candidateId = `sha256:${'d'.repeat(64)}`;
const consoleRef = `registry.invalid/cauce/console@sha256:${'e'.repeat(64)}`;
const consoleId = `sha256:${'f'.repeat(64)}`;
const candidateSource = `sha256:${'9'.repeat(64)}`;
const postgresRef = `registry.invalid/library/postgres@sha256:${'0'.repeat(64)}`;
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';
const platform = { os: 'linux', architecture: 'amd64' } as const;
const bridgeDockerfile = spawnSync(
  'git', ['show', `${resultingBridgeTree}:deploy/Dockerfile`], { cwd: repository, encoding: 'utf8' },
).stdout;
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
  const source = `sha256:${'6'.repeat(64)}`;
  const bridgeLabels = {
    'io.cauce.schema.compatible-through': '037_console_publish_intent_indexes.sql',
    'io.cauce.source.digest': source,
    'io.cauce.source.runtime': source,
    'io.cauce.rollback-bridge.tree': resultingBridgeTree,
    'io.cauce.rollback-bridge.patch-sha256': patchSetSha256,
    'io.cauce.rollback-bridge.patch-source-commit': '2'.repeat(40),
    'io.cauce.rollback-bridge.read-only': 'server-v2',
    'io.cauce.base.node.repository-digest': bridgeBase,
    'io.cauce.base.python.repository-digest': bridgePythonBase,
    'io.cauce.target-platform': 'linux/amd64',
    'org.opencontainers.image.base.name': bridgeBase,
  };
  const candidateLabels = {
    'io.cauce.schema.compatible-through': '037_console_publish_intent_indexes.sql',
    'io.cauce.source.digest': candidateSource,
    'io.cauce.base.node.repository-digest': bridgeBase,
    'io.cauce.base.python.repository-digest': bridgePythonBase,
    'io.cauce.target-platform': 'linux/amd64',
    'org.opencontainers.image.revision': '2'.repeat(40),
    'org.opencontainers.image.base.name': bridgeBase,
  };
  const bridgeStage = {
    repositoryDigest: bridgeRef, imageId: bridgeId,
    manifestDigest: bridgeRef.split('@')[1], mediaType: manifestMediaType, platform,
    labels: bridgeLabels,
  };
  const candidateStage = {
    repositoryDigest: candidateRef, imageId: candidateId,
    manifestDigest: candidateRef.split('@')[1], mediaType: manifestMediaType, platform,
    labels: candidateLabels,
  };
  const postgresStage = {
    repositoryDigest: postgresRef, imageId: `sha256:${'1'.repeat(64)}`,
    manifestDigest: postgresRef.split('@')[1], mediaType: manifestMediaType, platform,
  };
  const stageImages = (
    runtimeRole: 'candidate' | 'bridge',
    runtimeObservation: 'probe-containers-attested-and-drained'
      | 'writers-drained-image-selected'
      | 'compensated-running-container-attested',
  ) => ({
    runtimeRole,
    runtimeObservation,
    runtime: runtimeRole === 'bridge' ? bridgeStage : candidateStage,
    postgres: postgresStage,
  });
  const state = {
    migrationLedgerSha256: `sha256:${'1'.repeat(64)}`,
    reconciliationSha256: `sha256:${'2'.repeat(64)}`,
    profileContentSha256: `sha256:${'3'.repeat(64)}`,
    profileRevisionSha256: `sha256:${'4'.repeat(64)}`,
    profileRuntimeSha256: `sha256:${'9'.repeat(64)}`,
    shadowTargetPhaseSha256: `sha256:${'2'.repeat(64)}`,
    leasesSha256: `sha256:${'5'.repeat(64)}`,
    authSessionSha256: `sha256:${'6'.repeat(64)}`,
    publishJournalSha256: `sha256:${'a'.repeat(64)}`,
    fullDatabaseStateSha256: `sha256:${'b'.repeat(64)}`,
    rowCounts: {
      schemaMigrations: 34, migrationLedger: 9, migrationVerifications: 1,
      reconciliationRuns: 1, reconciliationHistory: 34, profiles: 15, agentRoles: 18,
      roleTemplates: 3, roleHistory: 15, leases: 12, gatewayOidcSessions: 2,
      profileRuntimeExpectations: 0, profileRuntimeAdoptions: 0,
      shadowRouterInbox: 0, shadowRouterMappings: 0,
      consolePublishAuditEvents: 0,
      messages: 4, idempotencyKeys: 4, deliveries: 4, deliveryAcks: 2, adapterOutbox: 3,
    },
  };
  const test = (name: string, mechanism: string) => ({ name, mechanism, status: 'passed', critical: true });
  return {
    schemaVersion: 11,
    suite: 'cauce-v3-rollback-bridge',
    evidenceClass: 'rollback-bridge',
    mechanism: 'isolated-restored-production-backup-runtime-image-cycle',
    generatedAt: generated.toISOString(),
    validUntil: validUntil.toISOString(),
    sourceDigest: source,
    sourceDigestDomain: 'runtime',
    operationsDigest: operations,
    dockerfileSha256: digest(bridgeDockerfile),
    composeFileSha256: composeSha256,
    sourceRevision: {
      originBaseCommit, patchSourceCommit: '2'.repeat(40),
      patchPath, resultingBridgeTree,
      patchSetSha256, worktreeStatus: 'clean', buildContext: 'git-archive',
    },
    runtime: {
      bridgeKind: 'origin-main-plus-schema029-shims-central-only-schema037', repositoryDigest: bridgeRef,
      imageId: bridgeId, manifestDigest: bridgeRef.split('@')[1],
      mediaType: manifestMediaType, platform, sourceDigest: source, sourceDigestDomain: 'runtime',
      baseImages: {
        node: {
          role: 'node', repositoryDigest: bridgeBase, imageId: `sha256:${'8'.repeat(64)}`,
          manifestDigest: bridgeBase.split('@')[1], mediaType: manifestMediaType, platform,
        },
        python: {
          role: 'python', repositoryDigest: bridgePythonBase, imageId: `sha256:${'7'.repeat(64)}`,
          manifestDigest: bridgePythonBase.split('@')[1], mediaType: manifestMediaType, platform,
        },
      },
      labels: bridgeLabels,
    },
    candidateRuntime: {
      repositoryDigest: candidateRef, imageId: candidateId,
      manifestDigest: candidateRef.split('@')[1], mediaType: manifestMediaType, platform,
      labels: candidateLabels,
      sourceDigest: candidateSource, sourceDigestDomain: 'runtime',
      sourceCommit: '2'.repeat(40), sourceTree: '4'.repeat(40),
      buildEvidenceSha256: `sha256:${'8'.repeat(64)}`,
    },
    database: {
      restoreEvidenceSha256: `sha256:${'a'.repeat(64)}`,
      restoreEvidenceVerifiedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      restoreEvidenceMaxAgeHours: 30,
      restoreEvidenceMaxFutureSkewSeconds: 300,
      restoredBackupSha256: `sha256:${'b'.repeat(64)}`,
      postgresRepositoryDigest: postgresRef,
      postgresImageId: `sha256:${'1'.repeat(64)}`,
      postgresManifestDigest: postgresRef.split('@')[1],
      postgresMediaType: manifestMediaType,
      postgresPlatform: platform,
      postgresMajor: 16, schemaLatest: '037_console_publish_intent_indexes.sql',
      connectionFencing: {
        migration: '031_connection_session_fencing.sql', table: 'connection_leases',
        column: 'connection_token', dataType: 'uuid', nullable: 'NO',
        totalLeaseCount: 12, nonNullTokenCount: 12, distinctTokenCount: 12, nullTokenCount: 0,
      },
      terminalClaimFencing: {
        migration: '032_terminal_session_claim_fencing.sql', table: 'terminal_sessions',
        constraint: 'terminal_sessions_relay_claim_shape', columnsExact: true,
        epochDefaultExact: true, constraintExact: true,
        openTerminalSessionCount: 0, legacyOpenSessionCount: 0,
        claimCas: 'passed', liveLeaseConflict: 'passed', takeoverEpochRotation: 'passed',
        staleCloseNoop: 'passed', exactClosePreservesFence: 'passed', transactionRollback: 'passed',
      },
      browserOwnerFencing: {
        migration: '033_terminal_browser_owner_fencing.sql', table: 'terminal_sessions',
        constraint: 'terminal_sessions_browser_owner_shape',
        requestIndex: 'terminal_sessions_request_id_idx', columnsExact: true,
        constraintExact: true, requestUniqueExact: true, openTerminalSessionCount: 0,
        invalidStoredFenceCount: 0, rawOwnerColumnCount: 0,
        exactPostRecoveryNoRotation: 'passed', requestMismatchConflict: 'passed',
        requestUnique: 'passed', ownerTakeoverCas: 'passed', staleDeleteNoop: 'passed',
        exactDelete: 'passed', transactionRollback: 'passed',
      },
      relayInstanceFencing: {
        migration: '034_terminal_relay_instance_fencing.sql', table: 'terminal_sessions',
        constraint: 'terminal_sessions_relay_instance_shape', columnsExact: true,
        constraintExact: true, usableTerminalSessionCount: 0, legacyUsableSessionCount: 0,
        invalidStoredFenceCount: 0, pinnedInstanceClaim: 'passed', liveBootConflict: 'passed',
        expiredBootTakeover: 'passed', staleBootCloseNoop: 'passed',
        exactClosePreservesFence: 'passed', constraintCounterexamples: 'passed',
        transactionRollback: 'passed',
      },
      profileRuntimeAdoption: {
        migration: '035_agent_profile_runtime_adoption.sql',
        expectationsTable: 'agent_profile_runtime_expectations',
        adoptionsTable: 'agent_profile_runtime_adoptions',
        tablesExact: true, constraintsExact: true, functionsExact: true, triggerExact: true,
        expectationCount: 0, adoptionCount: 0,
        invalidStoredExpectationCount: 0, invalidStoredAdoptionCount: 0,
        exactExpectationAdoption: 'passed', mismatchRejected: 'passed', deliveryUnique: 'passed',
        historyRetained: 'passed', transactionRollback: 'passed',
      },
      shadowTargetPhase: {
        migration: '036_shadow_router_target_phase.sql', migrationApplied: true,
        table: 'shadow_router_inbox',
        column: 'claim_target_started',
        constraint: 'shadow_router_inbox_claim_phase_shape',
        functions: [
          'cauce_shadow_router_claim_phase_transition',
          'cauce_shadow_router_mapping_status_monotonic',
          'cauce_shadow_router_mapping_terminal_reconcile',
        ],
        triggers: [
          'shadow_router_inbox_claim_phase_transition',
          'shadow_router_mapping_status_monotonic',
          'shadow_router_mapping_terminal_reconcile',
        ],
        columnsExact: true, constraintExact: true, functionsExact: true, triggersExact: true,
        processingCount: 0, invalidStoredPhaseCount: 0,
        pre036EagerClaimRejected: 'passed',
        unstartedReplay: 'passed', armedReplay: 'passed', observedSettlement: 'passed',
        terminalMappingMonotonic: 'passed', terminalMappingReconciliation: 'passed',
        transactionRollback: 'passed',
      },
      consolePublishJournal: {
        migration: '037_console_publish_intent_indexes.sql', migrationApplied: true,
        table: 'audit_events',
        indexes: [
          'audit_events_console_publish_head_037_idx',
          'audit_events_console_publish_key_037_idx',
          'audit_events_console_publish_nonce_037_idx',
          'audit_events_console_publish_rate_037_idx',
        ],
        indexCount: 4, unexpectedIndexCount: 0,
        allIndexesUsable: true, indexDefinitionsExact: true,
        keyLookupPlan: 'passed', nonceLookupPlan: 'passed',
        rateLimitPlan: 'passed', headLookupPlan: 'passed',
      },
      isolated: true,
      network: 'private-test-network', egress: 'disabled', productionConnected: false,
      snapshots: [
        { stage: 'candidate-after-migrate-037', ...state, images: stageImages('candidate', 'probe-containers-attested-and-drained') },
        { stage: 'bridge-after-noop-migrator-and-tests', ...state, images: stageImages('bridge', 'probe-containers-attested-and-drained') },
        { stage: 'candidate-after-return-noop-migrator-and-model-free-ack', ...state, images: stageImages('candidate', 'probe-containers-attested-and-drained') },
        { stage: 'candidate-before-injected-rollback-failure', ...state, images: stageImages('candidate', 'writers-drained-image-selected') },
        { stage: 'candidate-after-rollback-compensation', ...state, images: stageImages('candidate', 'compensated-running-container-attested') },
      ],
    },
    imageVerification: {
      targetPlatform: 'linux/amd64',
      acceptedManifestMediaTypes: [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
      ],
      pullPolicy: 'pull-exact-child-manifests', registryPullPerformed: true,
      explicitRegistryPullCount: 5, composePullPolicy: 'never-after-preflight', stageAttestationCount: 5,
      containerImageIdAttested: true,
      stageAttestationMechanism: 'compose-container-id-and-repodigest-reinspect',
    },
    digestContract: {
      algorithm: 'sha256', encoding: 'postgresql-jsonb-canonical-text-utf8',
      migrationLedger: schemaConst([
        'properties', 'digestContract', 'properties', 'migrationLedger', 'const',
      ]),
      reconciliation: schemaConst([
        'properties', 'digestContract', 'properties', 'reconciliation', 'const',
      ]),
      profileContent: schemaConst([
        'properties', 'digestContract', 'properties', 'profileContent', 'const',
      ]),
      profileRevision: schemaConst([
        'properties', 'digestContract', 'properties', 'profileRevision', 'const',
      ]),
      profileRuntime: schemaConst([
        'properties', 'digestContract', 'properties', 'profileRuntime', 'const',
      ]),
      shadowTargetPhase: schemaConst([
        'properties', 'digestContract', 'properties', 'shadowTargetPhase', 'const',
      ]),
      leases: schemaConst(['properties', 'digestContract', 'properties', 'leases', 'const']),
      authSessions: schemaConst(['properties', 'digestContract', 'properties', 'authSessions', 'const']),
      publishJournal: schemaConst(['properties', 'digestContract', 'properties', 'publishJournal', 'const']),
      fullDatabaseState: schemaConst(['properties', 'digestContract', 'properties', 'fullDatabaseState', 'const']),
    },
    topology: {
      composeFileSha256: composeSha256, services: ['postgres', 'candidate', 'bridge'],
      internalNetworkOnly: true, publishedPorts: 0, backupReadOnly: true,
      productionCredentialsAccepted: false, externalComponentsStarted: false,
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
        preMigrationIntegrity: 'passed', migratedThrough: '037_console_publish_intent_indexes.sql',
        postMigrationIntegrity: 'passed',
      },
      bridge: {
        allWritersDrained: true, migratorResult: 'no-op', centralServicesOnly: true,
        serverSideReadOnly: true, readOnlyCapability: 'server-v2',
        mutationContract: 'deny-all-data-api-with-operational-health-allowlist-and-oidc-get-head-denied-503',
        disabledExternalComponents: ['adapters', 'models', 'telegram', 'terminal-clients'], health: 'passed',
      },
      candidateReturn: {
        bridgeDrained: true, migratorResult: 'no-op', health: 'passed',
        modelFreeRoundtrip: 'publish-claim-ack', status: 'passed',
      },
      compensation: {
        rollbackAction: 'rollback-sh-shared-transaction',
        failureInjection: 'postgres-unavailable-after-selector-swap', failureObserved: true,
        lostForwardCasResponseRecovered: true,
        selectorCasRestored: true, candidateImageRestored: true, composeRecreateObserved: true,
        servicesRestored: true, transitionLockScope: 'selector-deploy-health-compensation',
        databaseDigestsUnchanged: true, productionRollbackDependency: false, status: 'passed',
      },
    },
    shims: [
      'profile-role-writes-frozen', 'unrelated-agent-update-omits-role-brief',
      'system-principals-filtered', 'gate-probe-explicitly-rejected',
      'server-side-read-only-mutation-gate', 'oidc-auth-reads-denied',
    ],
    tests: [
      test('profile-role-writes-frozen', 'source-tree-and-runtime-image-bound-test'),
      test('unrelated-agent-update-preserves-role', 'source-tree-and-runtime-image-bound-test'),
      test('system-principals-filtered', 'source-tree-and-runtime-image-bound-test'),
      test('gate-probe-explicitly-rejected', 'source-tree-and-runtime-image-bound-test'),
      test('oidc-auth-reads-denied', 'exact-bridge-image-real-routes-and-full-database-digest'),
      test('basic-read-delivery-compatible', 'runtime-package-and-database-health'),
      test('schema029-fleet-exact', 'database-exact-set'),
      test('agent-notify-role-exact', 'application-role-policy'),
      test('migration-ledger-and-reconciliation-noop', 'canonical-state-digest'),
      test('connection-leases-preserved', 'canonical-state-digest'),
      test('schema031-connection-fencing-exact', 'database-column-and-token-set'),
      test('schema032-terminal-claim-fencing-exact', 'database-shape-drain-and-transactional-cas'),
      test('schema033-browser-owner-fencing-exact', 'database-request-recovery-owner-cas-and-stale-delete'),
      test('schema034-relay-instance-fencing-exact', 'database-shape-drain-pinned-instance-and-boot-cas'),
      test('schema035-profile-runtime-adoption-exact', 'database-shape-trigger-exact-adoption-and-rollback'),
      test('schema036-shadow-target-phase-exact', 'database-shape-trigger-eager-rejection-crash-replay-race-reconciliation-and-rollback'),
      test('schema037-console-publish-journal-exact', 'four-index-shape-predicates-and-generic-plan-key-nonce-rate-head'),
      test('candidate-return-model-free-roundtrip', 'publish-claim-ack'),
      test('rollback-health-failure-compensates', 'rollback-sh-shared-transaction-postgres-outage'),
    ],
    summary: { tests: 19, passed: 19, failed: 0, skipped: 0, criticalSkipped: 0 },
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
  *' show '*':deploy/Dockerfile'*) printf '%s' "$FAKE_DOCKERFILE" ;;
  *' show '*':packages/store/migrations/'*) last=; for value in "$@"; do last=$value; done; relative=\${last#*:}; cat "$FAKE_REPOSITORY/$relative" ;;
  *' show '*) cat "$FAKE_PATCH_FILE" ;;
  *' write-tree'*) printf '%s\n' "$FAKE_TREE" ;;
  *' rev-parse --verify '*) printf '%s\n' "$FAKE_CANDIDATE_TREE" ;;
  *) exec "$REAL_GIT" "$@" ;;
esac
`, { mode: 0o755 });
  await chmod(git, 0o755);
  const evidence = join(directory, 'rollback-bridge.json');
  const evidenceText = `${JSON.stringify(bridgeReport(), null, 2)}\n`;
  await writeFile(evidence, evidenceText, { mode: 0o600 });
  await chmod(evidence, 0o600);
  await writeFile(`${evidence}.sha256`, `${digest(evidenceText)}\n`, { mode: 0o600 });
  await chmod(`${evidence}.sha256`, 0o600);
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
    FAKE_PATCH_FILE: join(repository, patchPath),
    FAKE_REPOSITORY: repository,
    FAKE_DOCKERFILE: bridgeDockerfile,
    FAKE_TREE: resultingBridgeTree,
    FAKE_CANDIDATE_TREE: '4'.repeat(40),
    REAL_GIT: '/usr/bin/git',
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

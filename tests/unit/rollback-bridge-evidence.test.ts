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
const composeSha256 = digest(await readFile(join(repository, 'ops/compose.rollback-bridge.yaml')));
const bridgeMetadata: unknown = JSON.parse(await readFile(
  join(repository, 'ops/rollback-bridge/metadata.json'), 'utf8',
));
const bridgeBase = nestedMetadataString('imagePublication', 'pinnedNodeBaseRepositoryDigest');
const bridgePythonBase = nestedMetadataString('imagePublication', 'pinnedPythonBaseRepositoryDigest');
const originBaseCommit = metadataString('originBaseCommit');
const patchPath = metadataString('patchPath');
const resultingBridgeTree = metadataString('resultingBridgeTree');
const patchSetSha256 = metadataString('patchSetSha256');
const runtimeRef = `registry.invalid/cauce/runtime-bridge@sha256:${'a'.repeat(64)}`;
const runtimeId = `sha256:${'b'.repeat(64)}`;
const candidateRef = `registry.invalid/cauce/runtime@sha256:${'e'.repeat(64)}`;
const candidateId = `sha256:${'f'.repeat(64)}`;
const candidateSource = `sha256:${'0'.repeat(64)}`;
const postgresRef = `registry.invalid/library/postgres@sha256:${'2'.repeat(64)}`;
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';
const platform = { os: 'linux', architecture: 'amd64' } as const;
const bridgeDockerfile = spawnSync(
  'git', ['show', `${resultingBridgeTree}:deploy/Dockerfile`], { cwd: repository, encoding: 'utf8' },
).stdout;
const scratch: string[] = [];

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function metadataString(property: string): string {
  if (typeof bridgeMetadata !== 'object' || bridgeMetadata === null || Array.isArray(bridgeMetadata)) {
    throw new Error('bridge metadata must be an object');
  }
  const value = (bridgeMetadata as Record<string, unknown>)[property];
  if (typeof value !== 'string') throw new Error(`bridge metadata.${property} must be a string`);
  return value;
}

function nestedMetadataString(parent: string, property: string): string {
  if (typeof bridgeMetadata !== 'object' || bridgeMetadata === null || Array.isArray(bridgeMetadata)) {
    throw new Error('bridge metadata must be an object');
  }
  const nested = (bridgeMetadata as Record<string, unknown>)[parent];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new Error(`bridge metadata.${parent} must be an object`);
  }
  const value = (nested as Record<string, unknown>)[property];
  if (typeof value !== 'string') throw new Error(`bridge metadata.${parent}.${property} must be a string`);
  return value;
}

function report() {
  const generated = new Date(Date.now() - 60_000);
  const validUntil = new Date(generated.getTime() + 24 * 60 * 60_000);
  const source = `sha256:${'c'.repeat(64)}`;
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
    repositoryDigest: runtimeRef, imageId: runtimeId,
    manifestDigest: runtimeRef.split('@')[1], mediaType: manifestMediaType, platform,
    labels: bridgeLabels,
  };
  const candidateStage = {
    repositoryDigest: candidateRef, imageId: candidateId,
    manifestDigest: candidateRef.split('@')[1], mediaType: manifestMediaType, platform,
    labels: candidateLabels,
  };
  const postgresStage = {
    repositoryDigest: postgresRef, imageId: `sha256:${'3'.repeat(64)}`,
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
  const snapshot = {
    migrationLedgerSha256: `sha256:${'5'.repeat(64)}`,
    reconciliationSha256: `sha256:${'6'.repeat(64)}`,
    profileContentSha256: `sha256:${'7'.repeat(64)}`,
    profileRevisionSha256: `sha256:${'8'.repeat(64)}`,
    profileRuntimeSha256: `sha256:${'1'.repeat(64)}`,
    shadowTargetPhaseSha256: `sha256:${'4'.repeat(64)}`,
    leasesSha256: `sha256:${'9'.repeat(64)}`,
    authSessionSha256: `sha256:${'3'.repeat(64)}`,
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
      originBaseCommit,
      patchSourceCommit: '2'.repeat(40),
      patchPath,
      resultingBridgeTree,
      patchSetSha256,
      worktreeStatus: 'clean',
      buildContext: 'git-archive',
    },
    runtime: {
      bridgeKind: 'origin-main-plus-schema029-shims-central-only-schema037',
      repositoryDigest: runtimeRef,
      imageId: runtimeId,
      manifestDigest: runtimeRef.split('@')[1],
      mediaType: manifestMediaType,
      platform,
      sourceDigest: source,
      sourceDigestDomain: 'runtime',
      baseImages: {
        node: {
          role: 'node', repositoryDigest: bridgeBase, imageId: `sha256:${'4'.repeat(64)}`,
          manifestDigest: bridgeBase.split('@')[1], mediaType: manifestMediaType, platform,
        },
        python: {
          role: 'python', repositoryDigest: bridgePythonBase, imageId: `sha256:${'d'.repeat(64)}`,
          manifestDigest: bridgePythonBase.split('@')[1], mediaType: manifestMediaType, platform,
        },
      },
      labels: bridgeLabels,
    },
    candidateRuntime: {
      repositoryDigest: candidateRef,
      imageId: candidateId,
      manifestDigest: candidateRef.split('@')[1],
      mediaType: manifestMediaType,
      platform,
      labels: candidateLabels,
      sourceDigest: candidateSource,
      sourceDigestDomain: 'runtime',
      sourceCommit: '2'.repeat(40),
      sourceTree: '4'.repeat(40),
      buildEvidenceSha256: `sha256:${'1'.repeat(64)}`,
    },
    database: {
      restoreEvidenceSha256: `sha256:${'8'.repeat(64)}`,
      restoreEvidenceVerifiedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      restoreEvidenceMaxAgeHours: 30,
      restoreEvidenceMaxFutureSkewSeconds: 300,
      restoredBackupSha256: `sha256:${'9'.repeat(64)}`,
      postgresRepositoryDigest: postgresRef,
      postgresImageId: `sha256:${'3'.repeat(64)}`,
      postgresManifestDigest: postgresRef.split('@')[1],
      postgresMediaType: manifestMediaType,
      postgresPlatform: platform,
      postgresMajor: 16,
      schemaLatest: '037_console_publish_intent_indexes.sql',
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
      network: 'private-test-network',
      egress: 'disabled',
      productionConnected: false,
      snapshots: [
        { stage: 'candidate-after-migrate-037', ...snapshot, images: stageImages('candidate', 'probe-containers-attested-and-drained') },
        { stage: 'bridge-after-noop-migrator-and-tests', ...snapshot, images: stageImages('bridge', 'probe-containers-attested-and-drained') },
        { stage: 'candidate-after-return-noop-migrator-and-model-free-ack', ...snapshot, images: stageImages('candidate', 'probe-containers-attested-and-drained') },
        { stage: 'candidate-before-injected-rollback-failure', ...snapshot, images: stageImages('candidate', 'writers-drained-image-selected') },
        { stage: 'candidate-after-rollback-compensation', ...snapshot, images: stageImages('candidate', 'compensated-running-container-attested') },
      ],
    },
    imageVerification: {
      targetPlatform: 'linux/amd64',
      acceptedManifestMediaTypes: [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
      ],
      pullPolicy: 'pull-exact-child-manifests',
      registryPullPerformed: true,
      explicitRegistryPullCount: 5,
      composePullPolicy: 'never-after-preflight',
      stageAttestationCount: 5,
      containerImageIdAttested: true,
      stageAttestationMechanism: 'compose-container-id-and-repodigest-reinspect',
    },
    digestContract: {
      algorithm: 'sha256',
      encoding: 'postgresql-jsonb-canonical-text-utf8',
      migrationLedger: 'schema_migrations(*)|schema_migration_ledger(*)|schema_migration_verifications(*);all-columns;all-rows;tables-listed-order;rows-primary-key-order',
      reconciliation: 'fleet_reconciliation_runs(*)|fleet_reconciliation_history(*);all-columns;all-rows;tables-listed-order;rows-primary-key-order',
      profileContent: 'agent_profiles(*-revision-applied_revision)|agents(tenant_id,alias,role_brief,role_template_slug)|agent_role_templates(*)|agent_role_brief_history(*);all-rows;tables-listed-order;rows-primary-key-order',
      profileRevision: 'agent_profiles(tenant_id,alias,revision,applied_revision);all-rows;rows-tenant_id-alias-order',
      profileRuntime: 'agent_profile_runtime_expectations(*)|agent_profile_runtime_adoptions(*);all-columns;all-rows;tables-listed-order;rows-primary-key-order',
      shadowTargetPhase: 'shadow_router_inbox(*)|shadow_router_mappings(*);all-columns;all-rows;tables-listed-order;rows-direction-source-event-id-order',
      leases: 'connection_leases(*);capabilities-jsonb;all-columns;all-rows;rows-tenant_id-alias-order',
      authSessions: 'gateway_oidc_sessions(*);all-columns-including-updated_at;all-rows;rows-kind-key_hash-order',
      publishJournal: 'audit_events(action-like-console.publish.%)|messages(*)|idempotency_keys(*)|deliveries(*)|delivery_acks(*)|adapter_outbox(*);all-columns;all-rows;tables-listed-order;audit-rows-id-order;other-rows-primary-key-order',
      fullDatabaseState: 'public ordinary tables(*)|public sequences(last_value,is_called);all-columns;all-rows;objects-name-order;rows-jsonb-text-order',
    },
    topology: {
      composeFileSha256: composeSha256,
      services: ['postgres', 'candidate', 'bridge'],
      internalNetworkOnly: true,
      publishedPorts: 0,
      backupReadOnly: true,
      productionCredentialsAccepted: false,
      externalComponentsStarted: false,
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
        migratedThrough: '037_console_publish_intent_indexes.sql',
        postMigrationIntegrity: 'passed',
      },
      bridge: {
        allWritersDrained: true,
        migratorResult: 'no-op',
        centralServicesOnly: true,
        serverSideReadOnly: true,
        readOnlyCapability: 'server-v2',
        mutationContract: 'deny-all-data-api-with-operational-health-allowlist-and-oidc-get-head-denied-503',
        disabledExternalComponents: ['adapters', 'models', 'telegram', 'terminal-clients'],
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
        rollbackAction: 'rollback-sh-shared-transaction',
        failureInjection: 'postgres-unavailable-after-selector-swap',
        failureObserved: true,
        lostForwardCasResponseRecovered: true,
        selectorCasRestored: true,
        candidateImageRestored: true,
        composeRecreateObserved: true,
        servicesRestored: true,
        databaseDigestsUnchanged: true,
        transitionLockScope: 'selector-deploy-health-compensation',
        productionRollbackDependency: false,
        status: 'passed',
      },
    },
    shims: [
      'profile-role-writes-frozen',
      'unrelated-agent-update-omits-role-brief',
      'system-principals-filtered',
      'gate-probe-explicitly-rejected',
      'server-side-read-only-mutation-gate',
      'oidc-auth-reads-denied',
    ],
    tests: [
      { name: 'profile-role-writes-frozen', mechanism: 'source-tree-and-runtime-image-bound-test', status: 'passed', critical: true },
      { name: 'unrelated-agent-update-preserves-role', mechanism: 'source-tree-and-runtime-image-bound-test', status: 'passed', critical: true },
      { name: 'system-principals-filtered', mechanism: 'source-tree-and-runtime-image-bound-test', status: 'passed', critical: true },
      { name: 'gate-probe-explicitly-rejected', mechanism: 'source-tree-and-runtime-image-bound-test', status: 'passed', critical: true },
      { name: 'oidc-auth-reads-denied', mechanism: 'exact-bridge-image-real-routes-and-full-database-digest', status: 'passed', critical: true },
      { name: 'basic-read-delivery-compatible', mechanism: 'runtime-package-and-database-health', status: 'passed', critical: true },
      { name: 'schema029-fleet-exact', mechanism: 'database-exact-set', status: 'passed', critical: true },
      { name: 'agent-notify-role-exact', mechanism: 'application-role-policy', status: 'passed', critical: true },
      { name: 'migration-ledger-and-reconciliation-noop', mechanism: 'canonical-state-digest', status: 'passed', critical: true },
      { name: 'connection-leases-preserved', mechanism: 'canonical-state-digest', status: 'passed', critical: true },
      { name: 'schema031-connection-fencing-exact', mechanism: 'database-column-and-token-set', status: 'passed', critical: true },
      { name: 'schema032-terminal-claim-fencing-exact', mechanism: 'database-shape-drain-and-transactional-cas', status: 'passed', critical: true },
      { name: 'schema033-browser-owner-fencing-exact', mechanism: 'database-request-recovery-owner-cas-and-stale-delete', status: 'passed', critical: true },
      { name: 'schema034-relay-instance-fencing-exact', mechanism: 'database-shape-drain-pinned-instance-and-boot-cas', status: 'passed', critical: true },
      { name: 'schema035-profile-runtime-adoption-exact', mechanism: 'database-shape-trigger-exact-adoption-and-rollback', status: 'passed', critical: true },
      { name: 'schema036-shadow-target-phase-exact', mechanism: 'database-shape-trigger-eager-rejection-crash-replay-race-reconciliation-and-rollback', status: 'passed', critical: true },
      { name: 'schema037-console-publish-journal-exact', mechanism: 'four-index-shape-predicates-and-generic-plan-key-nonce-rate-head', status: 'passed', critical: true },
      { name: 'candidate-return-model-free-roundtrip', mechanism: 'publish-claim-ack', status: 'passed', critical: true },
      { name: 'rollback-health-failure-compensates', mechanism: 'rollback-sh-shared-transaction-postgres-outage', status: 'passed', critical: true },
    ],
    summary: { tests: 19, passed: 19, failed: 0, skipped: 0, criticalSkipped: 0 },
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
  *' show '*':deploy/Dockerfile'*) printf '%s' "$FAKE_DOCKERFILE" ;;
  *' show '*':packages/store/migrations/'*) last=; for value in "$@"; do last=$value; done; relative=\${last#*:}; cat "$FAKE_REPOSITORY/$relative" ;;
  *' show '*) cat "$FAKE_PATCH_FILE" ;;
  *' write-tree'*) printf '%s\n' "$FAKE_TREE" ;;
  *' rev-parse --verify '*) printf '%s\n' "$FAKE_CANDIDATE_TREE" ;;
  *) exec "$REAL_GIT" "$@" ;;
esac
`, { mode: 0o755 });
  await chmod(git, 0o755);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(evidence, text, { mode: 0o600 });
  await chmod(evidence, 0o600);
  await writeFile(`${evidence}.sha256`, `${digest(text)}\n`, { mode: 0o600 });
  await chmod(`${evidence}.sha256`, 0o600);
  return {
    evidence,
    sha256: digest(text),
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_PATCH_FILE: join(repository, patchPath),
      FAKE_REPOSITORY: repository,
      FAKE_DOCKERFILE: bridgeDockerfile,
      FAKE_TREE: resultingBridgeTree,
      FAKE_CANDIDATE_TREE: '4'.repeat(40),
      REAL_GIT: '/usr/bin/git',
    },
  };
}

function run(
  evidence: string,
  sha256: string,
  image = runtimeRef,
  id = runtimeId,
  environment: NodeJS.ProcessEnv = process.env,
  allowNoPullDiagnostic = false,
) {
  const cliArguments = [
    validator,
    '--evidence', evidence,
    '--expected-evidence-sha256', sha256,
    '--expected-repository-digest', image,
    '--expected-image-id', id,
    '--expected-candidate-repository-digest', candidateRef,
    '--expected-candidate-image-id', candidateId,
    '--expected-candidate-source-digest', candidateSource,
  ];
  if (allowNoPullDiagnostic) cliArguments.push('--allow-no-pull-diagnostic');
  return spawnSync('python3', cliArguments, { encoding: 'utf8', env: environment });
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

    const publishDrift = report();
    const publishBridgeSnapshot = publishDrift.database.snapshots.at(1);
    if (!publishBridgeSnapshot) throw new Error('rollback bridge fixture is missing its bridge snapshot');
    publishBridgeSnapshot.publishJournalSha256 = `sha256:${'b'.repeat(64)}`;
    const publishDriftValue = await fixture(publishDrift);
    const publishDriftResult = run(
      publishDriftValue.evidence, publishDriftValue.sha256, runtimeRef, runtimeId,
      publishDriftValue.environment,
    );
    expect(publishDriftResult.status).toBe(1);
    expect(publishDriftResult.stderr).toContain('changed durable publish journal');

    const authDrift = report();
    authDrift.database.snapshots[1]!.authSessionSha256 = `sha256:${'c'.repeat(64)}`;
    const authDriftValue = await fixture(authDrift);
    const authDriftResult = run(
      authDriftValue.evidence, authDriftValue.sha256, runtimeRef, runtimeId,
      authDriftValue.environment,
    );
    expect(authDriftResult.status).toBe(1);
    expect(authDriftResult.stderr).toContain('changed OIDC login or session state');

    const fullStateDrift = report();
    fullStateDrift.database.snapshots[1]!.fullDatabaseStateSha256 = `sha256:${'c'.repeat(64)}`;
    const fullStateDriftValue = await fixture(fullStateDrift);
    const fullStateDriftResult = run(
      fullStateDriftValue.evidence, fullStateDriftValue.sha256, runtimeRef, runtimeId,
      fullStateDriftValue.environment,
    );
    expect(fullStateDriftResult.status).toBe(1);
    expect(fullStateDriftResult.stderr).toContain('changed full public database state');

    const stale = report();
    stale.generatedAt = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    stale.validUntil = new Date(Date.now() - 9 * 24 * 60 * 60_000).toISOString();
    const staleValue = await fixture(stale);
    expect(run(staleValue.evidence, staleValue.sha256, runtimeRef, runtimeId, staleValue.environment).status).toBe(1);
  });

  test('rejects manifest, provenance-label, and per-stage image drift semantically', async () => {
    const manifest = report();
    manifest.runtime.manifestDigest = `sha256:${'1'.repeat(64)}`;
    const manifestValue = await fixture(manifest);
    const manifestResult = run(
      manifestValue.evidence, manifestValue.sha256, runtimeRef, runtimeId, manifestValue.environment,
    );
    expect(manifestResult.status).toBe(1);
    expect(manifestResult.stderr).toContain('manifest digest differs from its RepoDigest');

    const labels = report();
    labels.runtime.labels['io.cauce.source.runtime'] = `sha256:${'1'.repeat(64)}`;
    const labelsValue = await fixture(labels);
    const labelsResult = run(
      labelsValue.evidence, labelsValue.sha256, runtimeRef, runtimeId, labelsValue.environment,
    );
    expect(labelsResult.status).toBe(1);
    expect(labelsResult.stderr).toContain('provenance labels differ');

    const stage = report();
    stage.database.snapshots[1]!.images.runtime.imageId = `sha256:${'1'.repeat(64)}`;
    const stageValue = await fixture(stage);
    const stageResult = run(
      stageValue.evidence, stageValue.sha256, runtimeRef, runtimeId, stageValue.environment,
    );
    expect(stageResult.status).toBe(1);
    expect(stageResult.stderr).toContain('runtime identity differs from its attested image');
  });

  test.each([
    '029_reconcile_declared_fleet.sql',
    '030_dlq_causal_reconciliation.sql',
    '031_connection_session_fencing.sql',
    '032_terminal_session_claim_fencing.sql',
    '033_terminal_browser_owner_fencing.sql',
    '034_terminal_relay_instance_fencing.sql',
    '035_agent_profile_runtime_adoption.sql',
  ])('rejects a bridge accredited only through obsolete schema %s', async (obsoleteSchema) => {
    const obsolete = report();
    obsolete.runtime.labels['io.cauce.schema.compatible-through'] = obsoleteSchema;
    obsolete.candidateRuntime.labels['io.cauce.schema.compatible-through'] = obsoleteSchema;
    const value = await fixture(obsolete);
    const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidence schema failed');
  });

  test('rejects an internally inconsistent schema-031 connection-token proof', async () => {
    const inconsistent = report();
    inconsistent.database.connectionFencing.distinctTokenCount = 11;
    const value = await fixture(inconsistent);
    const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('connection fencing evidence is inconsistent');
  });

  test('rejects schema-032 evidence with an open legacy terminal or failed stale-close proof', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => { value.database.terminalClaimFencing.legacyOpenSessionCount = 1; },
      (value: ReturnType<typeof report>) => { value.database.terminalClaimFencing.staleCloseNoop = 'failed'; },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('rejects schema-033 evidence with request drift, an open terminal or stale DELETE success', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => { value.database.browserOwnerFencing.requestUniqueExact = false; },
      (value: ReturnType<typeof report>) => { value.database.browserOwnerFencing.openTerminalSessionCount = 1; },
      (value: ReturnType<typeof report>) => { value.database.browserOwnerFencing.staleDeleteNoop = 'failed'; },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('rejects schema-034 evidence with an unpinned usable terminal or stale boot close', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => { value.database.relayInstanceFencing.legacyUsableSessionCount = 1; },
      (value: ReturnType<typeof report>) => { value.database.relayInstanceFencing.staleBootCloseNoop = 'failed'; },
      (value: ReturnType<typeof report>) => { value.database.relayInstanceFencing.constraintExact = false; },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('rejects schema-035 evidence with a missing trigger, malformed row, or failed exact adoption', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => { value.database.profileRuntimeAdoption.triggerExact = false; },
      (value: ReturnType<typeof report>) => {
        value.database.profileRuntimeAdoption.invalidStoredExpectationCount = 1;
      },
      (value: ReturnType<typeof report>) => {
        value.database.profileRuntimeAdoption.exactExpectationAdoption = 'failed';
      },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('rejects schema-036 evidence with phase drift, live claims, or failed crash replay', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => { value.database.shadowTargetPhase.functionsExact = false; },
      (value: ReturnType<typeof report>) => { value.database.shadowTargetPhase.processingCount = 1; },
      (value: ReturnType<typeof report>) => { value.database.shadowTargetPhase.armedReplay = 'failed'; },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('rejects schema-037 evidence with index, predicate, rate or head plan drift', async () => {
    for (const mutate of [
      (value: ReturnType<typeof report>) => {
        value.database.consolePublishJournal.indexDefinitionsExact = false;
      },
      (value: ReturnType<typeof report>) => {
        value.database.consolePublishJournal.indexes.pop();
      },
      (value: ReturnType<typeof report>) => {
        value.database.consolePublishJournal.rateLimitPlan = 'failed';
      },
      (value: ReturnType<typeof report>) => {
        value.database.consolePublishJournal.headLookupPlan = 'failed';
      },
    ]) {
      const inconsistent = report();
      mutate(inconsistent);
      const value = await fixture(inconsistent);
      const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('evidence schema failed');
    }
  });

  test('no-pull lifecycle evidence remains diagnostic unless explicitly admitted', async () => {
    const diagnostic = report();
    diagnostic.imageVerification.pullPolicy = 'no-pull-local-images-required';
    diagnostic.imageVerification.registryPullPerformed = false;
    diagnostic.imageVerification.explicitRegistryPullCount = 0;
    const value = await fixture(diagnostic);
    const release = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(release.status).toBe(1);
    expect(release.stderr).toContain('cannot authorize a release rollback');
    const local = run(
      value.evidence, value.sha256, runtimeRef, runtimeId, value.environment, true,
    );
    expect(local.status, local.stderr).toBe(0);
  });

  test('binds the original restore timestamp and rejects stale, future, or weakened policy', async () => {
    const staleRestore = report();
    staleRestore.database.restoreEvidenceVerifiedAt = new Date(
      Date.now() - 31 * 60 * 60_000,
    ).toISOString();
    const staleValue = await fixture(staleRestore);
    const staleResult = run(
      staleValue.evidence, staleValue.sha256, runtimeRef, runtimeId, staleValue.environment,
    );
    expect(staleResult.status).toBe(1);
    expect(staleResult.stderr).toContain('restore evidence is older');

    const futureRestore = report();
    futureRestore.database.restoreEvidenceVerifiedAt = new Date(
      Date.now() + 6 * 60_000,
    ).toISOString();
    const futureValue = await fixture(futureRestore);
    const futureResult = run(
      futureValue.evidence, futureValue.sha256, runtimeRef, runtimeId, futureValue.environment,
    );
    expect(futureResult.status).toBe(1);
    expect(futureResult.stderr).toContain('clock-skew policy');

    const weakened = report();
    weakened.database.restoreEvidenceMaxAgeHours = 168;
    const weakenedValue = await fixture(weakened);
    const weakenedResult = run(
      weakenedValue.evidence, weakenedValue.sha256, runtimeRef, runtimeId, weakenedValue.environment,
    );
    expect(weakenedResult.status).toBe(1);
    expect(weakenedResult.stderr).toContain('evidence schema failed');
  });

  test('fails closed on broad permissions without printing evidence contents', async () => {
    const value = await fixture();
    await chmod(value.evidence, 0o640);
    const result = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(runtimeRef);
    expect(await readFile(value.evidence, 'utf8')).toContain('profile-role-writes-frozen');

    await chmod(value.evidence, 0o600);
    await chmod(`${value.evidence}.sha256`, 0o640);
    const sidecar = run(value.evidence, value.sha256, runtimeRef, runtimeId, value.environment);
    expect(sidecar.status).toBe(1);
    expect(sidecar.stderr).toContain('SHA sidecar must be an owned single-link mode-0600 regular file');
    expect(sidecar.stdout + sidecar.stderr).not.toContain(runtimeRef);
  });
});

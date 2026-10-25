import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { enqueuePtyFleet, openPtyFleetPanel, ptyFleetAlias, ptyFleetOperations, ptyFleetRuntimeKey, type PtyFleetOperation } from './v4-pty-flota-dinamica.flow.js';
import { capturePtyFleet, ptyFleetPrefix, ptyFleetReceipt, type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

const execute = promisify(execFile);
type LegacyAction = 'prepare' | 'managed' | 'rollback' | 'foreign' | 'restore';
interface CredentialObservation { fingerprint: string; files: Record<string, { sha256: string; inode: number; mode: number }> }
interface LegacyObservation {
  credentials: CredentialObservation;
  legacy?: Record<string, boolean>;
  restored?: Record<string, boolean>;
  presence?: { relay_acknowledged: boolean };
  required?: boolean;
  reused?: boolean;
  credentials_unchanged?: boolean;
  safe_failure_journaled?: boolean;
  rollback?: { terminal_rollback_verified: boolean };
}

async function legacyAction(fixture: PtyFleetFixture, action: LegacyAction, operation?: PtyFleetOperation): Promise<LegacyObservation> {
  const code = await readFile('tests/e2e/v4-pty-flota-dinamica.legacy.py', 'utf8');
  const template = action === 'prepare' ? (await execute('git', ['show',
    'bd9134b8a^:ops/pty-agent/systemd/cauce-v3-pty@.service'])).stdout : undefined;
  const payload = { policy: join(fixture.computer.installRoot, fixture.owner.company.slug, fixture.hostId, 'executor-policy.json'),
    state: fixture.runtimeState, tenant: fixture.tenantId, company: fixture.owner.company.slug, alias: ptyFleetAlias, key: ptyFleetRuntimeKey,
    container: ptyFleetPrefix + '-' + ptyFleetRuntimeKey, template, operation_id: operation?.id };
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', code, action], JSON.stringify(payload));
  expect(result.code, 'owned legacy fixture ' + action + ' failed: ' + result.stderr).toBe(0);
  const observed = JSON.parse(result.stdout) as LegacyObservation;
  await ptyFleetReceipt('inherited-' + action + (operation ? '-' + operation.id : ''), observed);
  return observed;
}

async function inheritedOperation(fixture: PtyFleetFixture, kind: 'stop' | 'start' | 'update',
  expected: 'succeeded' | 'failed' = 'succeeded'): Promise<PtyFleetOperation> {
  const panel = await openPtyFleetPanel(fixture);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption(kind);
  if (kind === 'update') await panel.getByLabel('Nombre visible operativo').fill('PTY heredado adoptado');
  return enqueuePtyFleet(fixture, panel, kind, expected);
}

async function registeredFingerprint(fixture: PtyFleetFixture): Promise<string> {
  const registry = JSON.parse(await readFile(fixture.registryFile, 'utf8')) as
    { agents: { tenant_id: string; alias: string; fingerprint_sha256: string }[] };
  const rows = registry.agents.filter(row => row.tenant_id === fixture.tenantId && row.alias === ptyFleetAlias);
  expect(rows).toHaveLength(1);
  const fingerprint = rows[0]?.fingerprint_sha256.toLowerCase();
  if (!fingerprint) throw new Error('the inherited fixture has no uniquely registered certificate');
  return fingerprint;
}

function assertAdmitted(operation: PtyFleetOperation, fingerprint: string): void {
  expect(operation.steps.find(step => step.name === 'admission')).toMatchObject({ status: 'succeeded',
    evidence: { terminal_verified: true, terminal_certificate_sha256: fingerprint } });
}

async function retryInheritedOperation(fixture: PtyFleetFixture, failed: PtyFleetOperation): Promise<PtyFleetOperation> {
  await openPtyFleetPanel(fixture);
  const card = fixture.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
  await card.getByRole('button', { name: 'Reintentar', exact: true }).click();
  let result: PtyFleetOperation | undefined;
  await expect.poll(async () => {
    result = (await ptyFleetOperations(fixture)).find(row => row.id === failed.id);
    return (result?.version ?? 0) > failed.version && ['succeeded', 'failed', 'cancelled'].includes(result?.status ?? '');
  }, { timeout: 180_000, interval: 300 }).toBe(true);
  if (!result) throw new Error('the inherited PTY retry lost its operation identity');
  expect(result.status, 'inherited PTY retry error: ' + JSON.stringify(result.error)).toBe('succeeded');
  await ptyFleetReceipt('inherited-recovered-operation', result);
  return result;
}

export async function exerciseInheritedPtyFleet(fixture: PtyFleetFixture, fingerprint: string): Promise<void> {
  expect(await registeredFingerprint(fixture)).toBe(fingerprint);
  const legacy = await legacyAction(fixture, 'prepare');
  expect(legacy.required).toBe(true);
  expect(legacy.presence?.relay_acknowledged).toBe(true);
  expect(legacy.credentials.fingerprint).toBe(fingerprint);
  expect(Object.values(legacy.legacy ?? {})).not.toHaveLength(0);
  expect(Object.values(legacy.legacy ?? {}).every(Boolean)).toBe(true);
  await inheritedOperation(fixture, 'stop');
  const started = await inheritedOperation(fixture, 'start');
  assertAdmitted(started, fingerprint);
  const adopted = await legacyAction(fixture, 'managed', started);
  expect(adopted).toMatchObject({ required: true, reused: true, credentials_unchanged: true });
  expect(adopted.credentials).toEqual(legacy.credentials);
  expect(await registeredFingerprint(fixture)).toBe(fingerprint);
  await capturePtyFleet(fixture.page, 'inherited-start-adopted');
  const reconstructed = await legacyAction(fixture, 'prepare');
  expect(reconstructed.credentials).toEqual(legacy.credentials);
  expect(reconstructed.presence?.relay_acknowledged).toBe(true);
  const updated = await inheritedOperation(fixture, 'update');
  assertAdmitted(updated, fingerprint);
  const upgraded = await legacyAction(fixture, 'managed', updated);
  expect(upgraded.credentials).toEqual(legacy.credentials);
  expect(await registeredFingerprint(fixture)).toBe(fingerprint);
  await capturePtyFleet(fixture.page, 'inherited-update-adopted');
  const rolledBack = await legacyAction(fixture, 'rollback', updated);
  expect(rolledBack.rollback).toEqual({ terminal_rollback_verified: true });
  expect(Object.values(rolledBack.restored ?? {})).not.toHaveLength(0);
  expect(Object.values(rolledBack.restored ?? {}).every(Boolean)).toBe(true);
  expect(rolledBack.credentials).toEqual(legacy.credentials);
  expect(rolledBack.presence?.relay_acknowledged).toBe(true);
  await inheritedOperation(fixture, 'stop');
  const foreign = await legacyAction(fixture, 'foreign');
  expect(foreign.credentials).toEqual(legacy.credentials);
  const rejected = await inheritedOperation(fixture, 'start', 'failed');
  expect(rejected.error).toMatchObject({ step: 'admission', retryable: true, reason: 'terminal_provision_failed' });
  expect(rejected.steps.find(step => step.name === 'admission')?.evidence?.terminal_verified).not.toBe(true);
  expect(await registeredFingerprint(fixture)).toBe(fingerprint);
  await capturePtyFleet(fixture.page, 'inherited-foreign-execstart-rejected');
  const restored = await legacyAction(fixture, 'restore');
  expect(restored.credentials).toEqual(legacy.credentials);
  expect(restored.safe_failure_journaled).toBe(true);
  const recovered = await retryInheritedOperation(fixture, rejected);
  assertAdmitted(recovered, fingerprint);
  expect((await legacyAction(fixture, 'managed', recovered)).credentials).toEqual(legacy.credentials);
  await ptyFleetReceipt('inherited-complete', { started: started.id, updated: updated.id, rejected: rejected.id,
    recovered: recovered.id, terminal_required: true, generic_template: true, immutable_release_with_execstart: true,
    migration_metadata_initially_absent: true, same_registered_certificate_and_key_inode: true,
    rollback_scope: 'terminal publication from the real update operation journal', rollback_exact: true,
    foreign_execstart_rejected: true, shared_ancestors_group_writable_before_admission: true });
}

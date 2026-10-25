import { describe, expect, it } from 'vitest';
import { FleetOperationRequestSchema, FleetOperationSchema, sha256Hex, type FleetEvidence } from '@cauce/protocol';
import { fleetReplacementRuntimeDigest } from '@cauce/store';
import type { FleetExecution } from './executor.js';
import { replacementCompensationSnapshot, verifyReplacementCompensation } from './replacement-compensation.js';

function execution(): FleetExecution {
  const target = { resource: 'agent' as const, tenant_id: 'Steven', alias: 'restored' };
  const agent = { ...target, company_id: 'company', harness_id: 'codex', display_name: 'Original', enabled: true,
    runtime_key: 'restored', primary_room_id: 'room', host_id: 'host-a', runtime_mode: 'container',
    container_name: 'original', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/state/restored',
    systemd_user: null, primary_account_id: 'account', model_id: null, reasoning_effort: null, extensions: [],
    lifecycle_state: 'ready', created_at: '2026-01-01T00:00:00Z', retired_at: null, purged_at: null };
  const operation = FleetOperationSchema.parse({ id: '71000000-0000-4000-8000-000000000001', request_sha256: '0'.repeat(64),
    status: 'cancelling', version: 5, target, kind: 'update', actor: { tenant_id: 'Steven', alias: 'operator' },
    expected_revision: 1, desired_revision: 2, applied_revision: null,
    steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'artifacts', status: 'succeeded' },
      { name: 'credentials', status: 'succeeded' }, { name: 'stop', status: 'failed' }],
    error: { code: 'STEP_FAILED', step: 'stop', retryable: true },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  const request = FleetOperationRequestSchema.parse({ kind: 'update', target, expected_revision: 1,
    idempotency_key: 'restore-after-credentials', parameters: { runtime_key: 'restored', harness_id: 'codex',
      primary_room_id: 'room', memberships: [{ room_id: 'room', role: 'agent' }], placement: {
        host_id: 'host-a', mode: 'container', container_name: 'original', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/state/restored' } } });
  const body = { version: 1, operation_id: operation.id, company_id: 'company', target,
    previous_agents: [agent], previous_memberships: [] };
  const snapshot_canonical = JSON.stringify(body);
  return { operation, request, previous_agents: [agent], fenced_targets: [target],
    snapshot: { compensation_snapshot: { ...body, snapshot_canonical, snapshot_sha256: sha256Hex(snapshot_canonical) } } };
}

function evidence(current: FleetExecution): FleetEvidence {
  const snapshot = replacementCompensationSnapshot(current);
  if (!snapshot) throw new Error('restoration snapshot absent');
  const binding = { snapshot_sha256: snapshot.snapshot_sha256, original_container_id: 'a'.repeat(64),
    checkpoint_sha256: 'b'.repeat(64), authority_sha256: 'c'.repeat(64) };
  const runtime_digest = fleetReplacementRuntimeDigest(binding);
  return { stopped_verified: true, revocation_verified: true, runtime_digest,
    replacement_restored: { ...binding, runtime_digest, shared_authority_preserved: true, created_authority_revoked: true } };
}

describe('restoration after update credentials', () => {
  it('requires the sealed original proof even when the container name did not change', () => {
    const current = execution();
    expect(() => { verifyReplacementCompensation(current, evidence(current)); }).not.toThrow();
    expect(() => { verifyReplacementCompensation(current, { stopped_verified: true, revocation_verified: true }); })
      .toThrow();
  });
  it('rejects missing or altered snapshots after credentials instead of using generic revocation', () => {
    const current = execution();
    for (const compensation_snapshot of [undefined, null, {}, { snapshot_sha256: '0'.repeat(64) }]) {
      expect(() => replacementCompensationSnapshot({ ...current, snapshot: { compensation_snapshot } }))
        .toThrow();
    }
  });
  it('rejects evidence from another original, authority checkpoint or snapshot', () => {
    const current = execution(); const proof = evidence(current);
    const restored = proof.replacement_restored;
    if (!restored) throw new Error('proof absent');
    for (const field of ['snapshot_sha256', 'original_container_id', 'checkpoint_sha256', 'authority_sha256'] as const) {
      expect(() => { verifyReplacementCompensation(current, { ...proof,
        replacement_restored: { ...restored, [field]: 'f'.repeat(64) } }); }).toThrow();
    }
  });
  it('preserves only the unchanged legacy early restoration without a snapshot', () => {
    const current = execution(); current.snapshot = {};
    current.operation.steps = [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'failed' }];
    expect(replacementCompensationSnapshot(current)).toBeUndefined();
    current.snapshot = { compensation_snapshot: null };
    expect(() => replacementCompensationSnapshot(current)).toThrow();
  });
});

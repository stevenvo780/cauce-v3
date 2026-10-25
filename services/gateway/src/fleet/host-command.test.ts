import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performHostCommand, performHostCompensation, performHostLoginStop, performHostRetirement } from './host-command.js';
import type { FleetExecution } from './executor.js';
import { FleetErrorSchema, FleetExecutionReasonSchema, FleetOperationRequestSchema, sha256Hex } from '@cauce/protocol';
import { fleetExecutionFailure } from './recovery-host-command.js';
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const execution = { request: { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' },
  expected_revision: 0, idempotency_key: 'stop-one-safe', parameters: {} }, operation: { id: '71000000-0000-4000-8000-000000000001' }, fenced_targets: [], previous_agents: [{ runtime_key: 'physical-one', host_id: 'old-host' }], desired_memberships: [{ tenant_id: 'Steven', alias: 'one', room_id: 'room', role: 'operator', enabled: true }] } as unknown as FleetExecution;
async function helper(body: string) {
  const directory = await mkdtemp('/var/tmp/cauce-host-command-'); directories.push(directory);
  const executable = join(directory, 'host.py'); await writeFile(executable, body);
  return { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 1000 };
}
describe('host effect transport', () => {
  it('uses the separate retirement command and binds its receipt to the durable configuration commitment', async () => {
    const body = { version: 1, decision: 'configuration_committed', operation_id: execution.operation.id, company_id: 'company', host_id: 'old-host',
      snapshot_sha256: 'a'.repeat(64), request_sha256: 'b'.repeat(64), target_slice_sha256: 'c'.repeat(64), applied_revision: 4,
      original_container_id: 'd'.repeat(64), replacement_container_id: 'e'.repeat(64), replacement_started_at: 'started', runtime_digest: 'f'.repeat(64) };
    const commit_canonical = JSON.stringify(body); const commit = { ...body, commit_canonical, commit_sha256: sha256Hex(commit_canonical) };
    const current: FleetExecution = { ...execution, operation: { ...execution.operation, status: 'running' }, snapshot: { replacement_commit: commit } };
    const evidence = { stopped_verified: true, removed: [{ type: 'container', name: 'old-agent' }], replacement_retired: {
      commit_sha256: commit.commit_sha256, original_container_id: body.original_container_id,
      replacement_container_id: body.replacement_container_id, runtime_digest: body.runtime_digest, volumes_retained: true } };
    const config = await helper(`import json,sys\nx=json.load(sys.stdin)\nassert '--retire-replacement' in sys.argv and '--step' not in sys.argv\nassert x['snapshot']['replacement_commit']['decision']=='configuration_committed'\nprint(${JSON.stringify(JSON.stringify({ evidence }))})`);
    expect(await performHostRetirement(config, current, new AbortController().signal)).toEqual(evidence);
    await expect(performHostRetirement(config, { ...current, operation: { ...current.operation, status: 'cancelling' } }, new AbortController().signal)).rejects.toThrow();
    const wrong = await helper(`print(${JSON.stringify(JSON.stringify({ evidence: { ...evidence,
      replacement_retired: { ...evidence.replacement_retired, replacement_container_id: '1'.repeat(64) } } }))})`);
    await expect(performHostRetirement(wrong, current, new AbortController().signal)).rejects.toThrow();
  });
  it('imports release modules without creating bytecode under a shared umask', async () => {
    const config = await helper("import os\nos.umask(0o002)\nimport release_dependency,json,sys\nsys.stdin.read()\nassert sys.dont_write_bytecode and release_dependency.VALUE==1\nassert os.environ['PYTHONDONTWRITEBYTECODE']=='1'\nprint(json.dumps({'evidence':{'stopped_verified':True}}))");
    await writeFile(join(dirname(config.executable), 'release_dependency.py'), 'VALUE=1\n');
    expect(await performHostCommand(config, 'stop', execution, new AbortController().signal)).toEqual({ evidence: { stopped_verified: true } });
    expect(await readdir(dirname(config.executable))).not.toContain('__pycache__');
  });
  it.each([
    ['container image or ownership labels differ', 'CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT'],
    ['container resource limits differ from the approved shape', 'CONTAINER_RESOURCE_LIMITS_DRIFT'],
    ['container isolation differs from the approved shape', 'CONTAINER_ISOLATION_DRIFT'],
  ])('keeps login stopped as unconfirmed while exposing only the typed cause: %s', async (message, reason) => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderr = `SYNTHETIC_PRIVATE_FIXTURE https://example.invalid/login?code=private\u001b[31m\nfleet effect failed: ${message}\n`;
    const config = await helper(`import sys\nsys.stdin.read()\nsys.stderr.write(${JSON.stringify(stderr)})\nsys.exit(2)\n`);
    await expect(performHostLoginStop(config, execution, new AbortController().signal)).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED', reason });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toContain(`stderr=${reason}`);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/SYNTHETIC_PRIVATE_FIXTURE|example\.invalid|code=private|\\u001b/u);
    await expect(performHostCommand(config, 'stop', execution, new AbortController().signal)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE', reason });
  });
  it('journals the identity probe reason of authenticate and carries it without any other stderr', async () => {
    const journal = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderr = 'SYNTHETIC_PRIVATE_FIXTURE token=private\nfleet identity probe failed: probe_timeout after 61s\n';
    const pending = await helper(`import json,sys\nsys.stdin.read()\nsys.stderr.write(${JSON.stringify(stderr)})\nprint(json.dumps({'evidence':{},'awaiting_auth':True}))\n`);
    expect(await performHostCommand(pending, 'authenticate', execution, new AbortController().signal))
      .toEqual({ evidence: {}, awaiting_auth: true, probe_failure: 'PROBE_TIMEOUT' });
    const lines = journal.mock.calls.map(call => String(call[0]));
    expect(lines).toContain(`provider auth helper failed: probe_timeout after 61s operation_id=${execution.operation.id}\n`);
    expect(lines.join('')).not.toMatch(/SYNTHETIC_PRIVATE_FIXTURE|token=private/u);
    const failed = await helper(`import sys\nsys.stdin.read()\nsys.stderr.write(${JSON.stringify(stderr)})\nsys.exit(2)\n`);
    await expect(performHostCommand(failed, 'authenticate', execution, new AbortController().signal))
      .rejects.toMatchObject({ code: 'HOST_UNAVAILABLE', reason: 'PROBE_TIMEOUT' });
    const verified = await helper(`import json,sys\nsys.stdin.read()\nsys.stderr.write(${JSON.stringify(stderr)})\nprint(json.dumps({'evidence':{'provider_verified':True}}))\n`);
    expect(await performHostCommand(verified, 'authenticate', execution, new AbortController().signal)).toEqual({ evidence: { provider_verified: true } });
  });
  it('keeps unknown or truncated login-stop stderr private and rejects without a typed cause', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = 'fleet effect failed: container resource limits differ from the approved shape';
    for (const stderr of ['SYNTHETIC_PRIVATE_FIXTURE https://example.invalid/login?code=private\n',
      'x'.repeat(4096 - message.length - 1) + '\n' + message + 'SYNTHETIC_PRIVATE_FIXTURE\n']) {
      const config = await helper(`import sys\nsys.stdin.read()\nsys.stderr.write(${JSON.stringify(stderr)})\nsys.exit(2)\n`);
      await expect(performHostLoginStop(config, execution, new AbortController().signal)).rejects.toThrow('Host effect could not be verified');
    }
    expect(diagnostic).toHaveBeenCalledTimes(2);
    for (const call of diagnostic.mock.calls) expect(call[0]).toContain('stderr=helper_failed');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/SYNTHETIC_PRIVATE_FIXTURE|example\.invalid|code=private/u);
  });
  it('requires demonstrated stop from login-stop without revoking the credentials', async () => {
    const config = await helper(`import json,sys\nx=json.load(sys.stdin)\nassert sys.argv[-1]=='login-stop'\nassert x['previous_agents'][0]['runtime_key']=='physical-one'\nprint(json.dumps({'evidence':{'stopped_verified':True}}))`);
    expect(await performHostLoginStop(config, execution, new AbortController().signal)).toEqual({ stopped: true });
    const unverified = await helper(`print('{"evidence":{}}')`);
    await expect(performHostLoginStop(unverified, execution, new AbortController().signal)).rejects.toThrow();
  });
  it('requires checked stop and revocation from a separate compensation command without changing fenced inputs', async () => {
    const config = await helper(`import json,sys\nx=json.load(sys.stdin)\nassert sys.argv[-1]=='compensate'\nassert x['previous_agents'][0]['runtime_key']=='physical-one'\nprint(json.dumps({'evidence':{'stopped_verified':True,'revocation_verified':True}}))`);
    expect(await performHostCompensation(config, execution, new AbortController().signal))
      .toEqual({ stopped_verified: true, revocation_verified: true });
    for (const evidence of [{}, { stopped_verified: true }, { stopped_verified: true, revocation_verified: false }]) {
      const unchecked = await helper(`print(${JSON.stringify(JSON.stringify({ evidence }))})`);
      await expect(performHostCompensation(unchecked, execution, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('passes structured identity through stdin and accepts only typed evidence', async () => {
    const config = await helper(`import json,sys\nx=json.load(sys.stdin)\nassert x['request']['target']['alias']=='one'\nassert x['previous_agents'][0]['runtime_key']=='physical-one'\nassert x['desired_memberships'][0]['enabled'] is True\nassert '--step' in sys.argv\nprint(json.dumps({'evidence':{'stopped_verified':True}}))`);
    expect(await performHostCommand(config, 'stop', execution, new AbortController().signal)).toEqual({ evidence: { stopped_verified: true } });
  });
  it('does not expose stderr, arbitrary process output or malformed receipts', async () => {
    for (const body of ["import sys; print('SENSITIVE',file=sys.stderr); sys.exit(1)", "print('SENSITIVE')", "print('{\"evidence\":{},\"stdout\":\"SENSITIVE\"}')"]) {
      const config = await helper(body);
      await expect(performHostCommand(config, 'stop', execution, new AbortController().signal)).rejects.toThrow(/^Host effect could not be verified$/u);
    }
  });
  it('terminates an expired effect without starting later steps', async () => {
    const config = await helper('import time; time.sleep(60)');
    const abort = new AbortController();
    const result = performHostCommand(config, 'stop', execution, abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow('Host effect could not be verified');
  });
  it.each(['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge', 'recover'] as const)('carries a typed failure for %s without exposing process diagnostics', async kind => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = await helper("import sys\nsys.stdin.read()\nprint('PRIVATE_SECRET_DIAGNOSTIC',file=sys.stderr)\nprint('CAUCE_FLEET_FAILURE=runtime_identity_mismatch',file=sys.stderr)\nsys.exit(2)");
    const parameters = kind === 'recover' ? { action: 'probe' } : kind === 'create' || kind === 'update' ? {
      runtime_key: 'physical-one', harness_id: 'codex', primary_room_id: 'office', memberships: [{ room_id: 'office', role: 'agent' }],
      placement: { host_id: 'old-host', mode: 'container', container_name: 'cauce-one', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/one' } } : {};
    const current = { ...execution, request: FleetOperationRequestSchema.parse({ ...execution.request, kind, parameters }) };
    await expect(performHostCommand(config, 'stop', current, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'runtime_identity_mismatch', message: 'No se pudo completar este paso de la ejecución.' });
  });
  it('carries compensation failure without reporting confirmed cleanup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = await helper("import sys\nsys.stdin.read()\nassert sys.argv[-1]=='compensate'\nprint('CAUCE_FLEET_FAILURE=runtime_stop_unverified',file=sys.stderr)\nsys.exit(2)");
    await expect(performHostCompensation(config, execution, new AbortController().signal)).rejects.toMatchObject({ reason: 'runtime_stop_unverified' });
  });
  it('accepts the finite vocabulary and legacy recovery markers while rejecting ambiguous or private causes', () => {
    for (const reason of FleetExecutionReasonSchema.options) {
      expect(fleetExecutionFailure(`PRIVATE\nCAUCE_FLEET_FAILURE=${reason}\n`)).toMatchObject({ reason });
      expect(FleetErrorSchema.parse({ code: 'STEP_FAILED', retryable: true, reason }).reason).toBe(reason);
    }
    expect(FleetErrorSchema.parse({ code: 'STEP_FAILED', retryable: true })).not.toHaveProperty('reason');
    expect(fleetExecutionFailure('CAUCE_RECOVERY_FAILURE=runtime_mounts_differ\n')).toMatchObject({ reason: 'runtime_mounts_differ' });
    expect(fleetExecutionFailure('CAUCE_FLEET_FAILURE=runtime_mounts_differ\nCAUCE_RECOVERY_FAILURE=runtime_mounts_differ\n'))
      .toMatchObject({ reason: 'runtime_mounts_differ' });
    for (const stderr of ['CAUCE_FLEET_FAILURE=runtime_identity_mismatch', 'CAUCE_FLEET_FAILURE=PRIVATE\n',
      'CAUCE_FLEET_FAILURE=runtime_identity_mismatch PRIVATE\n', 'CAUCE_RECOVERY_FAILURE=runtime_identity_mismatch\n',
      'CAUCE_FLEET_FAILURE=runtime_identity_mismatch\nCAUCE_RECOVERY_FAILURE=runtime_mounts_differ\n',
      'CAUCE_FLEET_FAILURE=runtime_identity_mismatch\nCAUCE_FLEET_FAILURE=runtime_identity_mismatch\n',
      `PRIVATE${'x'.repeat(4096)}\nCAUCE_FLEET_FAILURE=runtime_identity_mismatch\n`]) expect(fleetExecutionFailure(stderr)).toBeUndefined();
    expect(FleetErrorSchema.safeParse({ code: 'STEP_FAILED', retryable: true, reason: 'PRIVATE' }).success).toBe(false);
  });
});

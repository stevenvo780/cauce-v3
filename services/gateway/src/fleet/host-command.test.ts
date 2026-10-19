import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performHostCommand, performHostCompensation, performHostLoginStop } from './host-command.js';
import type { FleetExecution } from './executor.js';
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
});

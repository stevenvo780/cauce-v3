import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performHostCommand } from './host-command.js';
import type { FleetExecution } from './executor.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const execution = { request: { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' },
  expected_revision: 0, idempotency_key: 'stop-one-safe', parameters: {} }, operation: { id: '71000000-0000-4000-8000-000000000001' }, fenced_targets: [], previous_agents: [{ runtime_key: 'physical-one', host_id: 'old-host' }], desired_memberships: [{ tenant_id: 'Steven', alias: 'one', room_id: 'room', role: 'operator', enabled: true }] } as unknown as FleetExecution;
async function helper(body: string) {
  const directory = await mkdtemp('/var/tmp/cauce-host-command-'); directories.push(directory);
  const executable = join(directory, 'host.py'); await writeFile(executable, body);
  return { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 1000 };
}
describe('host effect transport', () => {
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

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetOperationClaim } from '@cauce/store';
import { beginMaintenanceGuard, MaintenanceGuardUnavailable } from './host-maintenance-guard.js';
import type { FleetExecution } from './executor.js';

const OPERATION = '71000000-0000-4000-8000-000000000001';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const execution = { operation: { id: OPERATION }, request: { target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' } },
  snapshot: { agents: [{ tenant_id: 'Steven', alias: 'one' }] } } as unknown as FleetExecution;
const claim = { claim_token: '71000000-0000-4000-8000-000000000002', epoch: 1 } as FleetOperationClaim;
async function helper(body: string) {
  const directory = await mkdtemp('/var/tmp/cauce-maintenance-guard-'); directories.push(directory);
  const executable = join(directory, 'guard.py'); await writeFile(executable, body);
  return { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 5000 };
}

describe('maintenance guard helper', () => {
  it('carries the fixed failure of a helper that exits before any event, and nothing else it printed', async () => {
    const config = await helper("import sys\nsys.stdin.readline()\nprint('PRIVATE_SECRET_DIAGNOSTIC',file=sys.stderr)\n"
      + "print('CAUCE_FLEET_FAILURE=runtime_identity_mismatch',file=sys.stderr)\n"
      + "print('fleet effect failed: running runtime has another SDK identity or transport',file=sys.stderr)\nsys.exit(2)\n");
    const failure = await beginMaintenanceGuard(config, execution, claim, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaintenanceGuardUnavailable);
    expect((failure as MaintenanceGuardUnavailable).detail)
      .toBe('runtime_identity_mismatch: running runtime has another SDK identity or transport');
    expect((failure as Error).message).toBe('Host maintenance guard could not be verified');
  });
  it('accepts the named preflight cause of a deferral and rejects an unbounded one', async () => {
    const named = await helper("import json,sys\nsys.stdin.readline()\nprint(json.dumps({'state':'deferred',"
      + "'reason':'preflight_unavailable','detail':'bundle_without_shared_tui'}),flush=True)\nsys.stdin.read()\n");
    const guard = await beginMaintenanceGuard(named, execution, claim, new AbortController().signal);
    expect(guard.first).toEqual({ state: 'deferred', reason: 'preflight_unavailable', detail: 'bundle_without_shared_tui' });
    await guard.finish(false);
    const free = await helper("import json,sys\nsys.stdin.readline()\nprint(json.dumps({'state':'deferred',"
      + "'reason':'preflight_unavailable','detail':'Free Text'}),flush=True)\nsys.stdin.read()\n");
    await expect(beginMaintenanceGuard(free, execution, claim, new AbortController().signal))
      .rejects.toBeInstanceOf(MaintenanceGuardUnavailable);
  });
});

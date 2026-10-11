import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaOperationExecution } from '@cauce/store';
import { performQuotaHostCommand, verifyQuotaAuthenticationHostCommand } from './quota-host-command.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const execution: QuotaOperationExecution = { operation_id: '21000000-0000-4000-8000-000000000001', action: 'delete', consent: false,
  environment: { id: '21000000-0000-4000-8000-000000000002', company_id: 'fixture', account_id: 'fixture-account', host_id: 'fixture-host',
    provider: 'codex', container_name: 'cauce-quota-21000000000040008000000000000002' } };
async function helper(body: string) {
  const directory = await mkdtemp('/var/tmp/cauce-quota-command-'); directories.push(directory);
  const executable = join(directory, 'host.py'); await writeFile(executable, body);
  return { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 1000 };
}
describe('quota effect through the fleet executor command', () => {
  it('passes only the typed quota payload through stdin and requires both deletion proofs', async () => {
    const config = await helper("import json,sys\nx=json.load(sys.stdin)\nassert sys.argv[-1]=='--quota'\nassert x['action']=='delete'\nprint(json.dumps({'stopped_verified':True,'profile_removed_verified':True}))");
    expect(await performQuotaHostCommand(config,execution,new AbortController().signal)).toEqual({ stopped_verified: true, profile_removed_verified: true });
    const incomplete = await helper("print('{\"stopped_verified\":true}')");
    await expect(performQuotaHostCommand(incomplete,execution,new AbortController().signal)).rejects.toThrow();
  });
  it('keeps failed process output private and terminates work on shutdown', async () => {
    const failed = await helper("import sys; print('fixture-secret',file=sys.stderr);sys.exit(1)");
    await expect(performQuotaHostCommand(failed,execution,new AbortController().signal)).rejects.toThrow('could not be verified');
    const waiting = await helper('import time;time.sleep(60)'); const abort = new AbortController();
    const effect = performQuotaHostCommand(waiting,execution,abort.signal); abort.abort();
    await expect(effect).rejects.toThrow();
  });
  it('verifies authentication through the closed helper only with consent and a real identity receipt', async () => {
    const input = { ...execution, action: 'authenticate' as const, consent: true };
    const config = await helper("import json,sys\nx=json.load(sys.stdin)\nassert sys.argv[-1]=='--quota-auth-verify'\nassert x['action']=='authenticate' and x['consent']\nprint(json.dumps({'authenticated_verified':True,'account_identity':'remote-subscription'}))");
    expect(await verifyQuotaAuthenticationHostCommand(config,input,new AbortController().signal))
      .toEqual({ authenticated_verified: true, account_identity: 'remote-subscription' });
    await expect(verifyQuotaAuthenticationHostCommand(config,{ ...input, consent: false },new AbortController().signal)).rejects.toThrow('consent');
    const missing = await helper("print('{\"authenticated_verified\":true}')");
    await expect(verifyQuotaAuthenticationHostCommand(missing,input,new AbortController().signal)).rejects.toThrow();
  });
});

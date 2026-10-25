import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentQuotaExecution } from '@cauce/protocol';
import { performAgentQuotaHostCommand } from './agent-quota-host-command.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const execution: AgentQuotaExecution = {
  operation_id: '71000000-0000-4000-8000-000000000001',
  action: 'query',
  agent: {
    operation_id: '71000000-0000-4000-8000-000000000001',
    expected_revision: 0,
    company_id: 'fixture',
    tenant_id: 'Tenant',
    alias: 'agent',
    harness_id: 'codex',
    host_id: 'fixture-host',
    runtime_mode: 'container',
    container_name: 'cauce-agent-container',
    runtime_user: 'dev',
    home_directory: '/home/dev',
    state_directory: '/home/dev/.cauce/agent',
    runtime_key: 'agent-key',
    systemd_user: null,
    primary_account_id: 'codex-dynamic-account',
  },
};

async function helper(body: string) {
  const directory = await mkdtemp('/var/tmp/cauce-agent-quota-command-');
  directories.push(directory);
  const executable = join(directory, 'host.py');
  await writeFile(executable, body);
  return { python: '/usr/bin/python3', executable, policyFile: join(directory, 'policy.json'), timeoutMs: 3000 };
}

describe('agent quota host command packet forwarding', () => {
  it('omits trusted_accounts from stdin packet when not provided in execution', async () => {
    const script = `import json,sys
x=json.load(sys.stdin)
assert sys.argv[-1]=='--quota'
assert x['action']=='query_agent'
assert 'trusted_accounts' not in x
res={'operation_id':x['operation_id'],'tenant':x['agent']['tenant_id'],'alias':x['agent']['alias'],
'host_id':x['agent']['host_id'],'container_name':x['agent']['container_name'],'harness':x['agent']['harness_id'],
'captured_at':'2026-01-01T00:00:00Z','status':'unsupported','reason':'quota_reader_unavailable'}
print(json.dumps(res))`;
    const config = await helper(script);
    const receipt = await performAgentQuotaHostCommand(config, execution, new AbortController().signal);
    expect(receipt).toMatchObject({ status: 'unsupported', reason: 'quota_reader_unavailable' });
  });

  it('includes trusted_accounts in stdin packet when provided in execution', async () => {
    const trusted_accounts = [{
      id: 'codex-dynamic-account',
      provider: 'codex',
      external_account_id: 'dynamic-user@example.invalid',
      payer_tenant_id: 'Tenant',
      shared_with_pool: false,
      enabled: true,
    }];
    const executionWithTrusted: AgentQuotaExecution = { ...execution, trusted_accounts };
    const script = `import json,sys
x=json.load(sys.stdin)
assert sys.argv[-1]=='--quota'
assert x['action']=='query_agent'
assert x['trusted_accounts']==json.loads('${JSON.stringify(trusted_accounts)}')
res={'operation_id':x['operation_id'],'tenant':x['agent']['tenant_id'],'alias':x['agent']['alias'],
'host_id':x['agent']['host_id'],'container_name':x['agent']['container_name'],'harness':x['agent']['harness_id'],
'captured_at':'2026-01-01T00:00:00Z','status':'measured','provider':'codex',
'identity_hash':'${'a'.repeat(64)}','observation_status':'ok',
'provider_report':{'provider':'codex','ok':True,'available':True,'available_groups':[],'limiting_groups':[],'windows':[]}}
print(json.dumps(res))`;
    const config = await helper(script);
    const receipt = await performAgentQuotaHostCommand(config, executionWithTrusted, new AbortController().signal);
    expect(receipt).toMatchObject({ status: 'measured', provider: 'codex' });
  });

  it('rejects a receipt whose scope differs from execution', async () => {
    const script = `import json,sys
x=json.load(sys.stdin)
res={'operation_id':x['operation_id'],'tenant':'wrong-tenant','alias':x['agent']['alias'],
'host_id':x['agent']['host_id'],'container_name':x['agent']['container_name'],'harness':x['agent']['harness_id'],
'captured_at':'2026-01-01T00:00:00Z','status':'unsupported','reason':'quota_reader_unavailable'}
print(json.dumps(res))`;
    const config = await helper(script);
    await expect(performAgentQuotaHostCommand(config, execution, new AbortController().signal))
      .rejects.toThrow('Agent quota receipt is outside its execution scope');
  });
});

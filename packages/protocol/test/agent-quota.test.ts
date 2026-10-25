import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentQuotaClaimSchema, AgentQuotaExecutionSchema, AgentQuotaQuerySchema, AgentQuotaReceiptSchema } from '../src/agent-quota.js';

describe('agent quota durable contracts', () => {
  it('rejects extra command, identity and authority fields in the typed query and claims', () => {
    expect(AgentQuotaQuerySchema.safeParse({ expected_revision: 0, idempotency_key: 'zz-canary-query' }).success).toBe(true);
    expect(AgentQuotaQuerySchema.safeParse({ expected_revision: 0, idempotency_key: 'zz-canary-query', command: 'arbitrary' }).success).toBe(false);
    const claim = { id: randomUUID(), tenant_id: 'Canary', alias: 'worker', claim_token: randomUUID(), claim_epoch: 1, worker_id: 'zz_canary' };
    expect(AgentQuotaClaimSchema.safeParse(claim).success).toBe(true);
    expect(AgentQuotaClaimSchema.safeParse({ ...claim, claim_epoch: 0 }).success).toBe(false);
    expect(AgentQuotaClaimSchema.safeParse({ ...claim, company_id: 'other' }).success).toBe(false);
  });
  it('requires matching operation identity and a typed container placement and accepts optional trusted accounts', () => {
    const id = randomUUID(); const execution = { operation_id: id, action: 'query', agent: { operation_id: id, expected_revision: 0,
      company_id: 'canary', tenant_id: 'Canary', alias: 'worker', harness_id: 'codex', host_id: 'zz-canary', runtime_mode: 'container',
      container_name: 'zz-canary-worker', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce',
      runtime_key: 'zz-canary-worker', systemd_user: 'stev', primary_account_id: 'primary-one' } };
    expect(AgentQuotaExecutionSchema.safeParse(execution).success).toBe(true);
    expect(AgentQuotaExecutionSchema.safeParse({ ...execution, operation_id: randomUUID() }).success).toBe(false);
    expect(AgentQuotaExecutionSchema.safeParse({ ...execution, agent: { ...execution.agent, runtime_mode: 'native' } }).success).toBe(false);
    const validAccount = { id: 'primary-one', provider: 'codex', external_account_id: 'user@example.invalid',
      payer_tenant_id: 'Canary', shared_with_pool: false, enabled: true };
    expect(AgentQuotaExecutionSchema.safeParse({ ...execution, trusted_accounts: [validAccount] }).success).toBe(true);
    expect(AgentQuotaExecutionSchema.safeParse({ ...execution, trusted_accounts: [{ ...validAccount, extra: true }] }).success).toBe(false);
    expect(AgentQuotaExecutionSchema.safeParse({ ...execution, trusted_accounts: [{ ...validAccount, id: 'INVALID/ID' }] }).success).toBe(false);
  });
  it('accepts an explicit unsupported observation and rejects credentials in the envelope', () => {
    const receipt = { operation_id: randomUUID(), tenant: 'Canary', alias: 'worker', host_id: 'zz-canary', container_name: 'zz-canary-worker',
      harness: 'openclaw', captured_at: new Date().toISOString(), status: 'unsupported', reason: 'quota_reader_unavailable' };
    expect(AgentQuotaReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(AgentQuotaReceiptSchema.safeParse({ ...receipt, account_identity: 'secret' }).success).toBe(false);
    expect(AgentQuotaReceiptSchema.safeParse({ ...receipt, reason: 'arbitrary' }).success).toBe(false);
  });
});

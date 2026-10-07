import { describe, expect, it, beforeEach } from 'vitest';
import {
  AGENT_BEHAVIOR_POLICY_V1_CAPABILITY, DeliveryEnvelopeSchema, type ConfigMutation,
} from '@cauce/protocol';
import { readAgentBehaviorPolicy } from '../src/agent-behavior-policy.js';
import { ConfigurationRepository } from '../src/configuration.js';
import {
  pool, repository, command, registerEgressSuite, createDestination, grantNotifyRole,
  ackWith, notifyOutput, notifications,
} from './egress-notification-postgres-helpers.js';
import { requireValue } from './helpers.js';

registerEgressSuite(import.meta.url);
const scope = { tenant_id: 'Steven', room_id: 'grp.steven', alias: 'argos' };
const value = { version: 1 as const, coordination_mode: 'executor' as const, fanin_receipt_mode: 'technical' as const };
const create = (overrides: Partial<typeof value> = {}): ConfigMutation => ({
  resource: 'agent_behavior_policy', action: 'create', ...scope, value: { ...value, ...overrides },
});
async function revision(): Promise<number> {
  const rows = await pool.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions');
  return Number(rows.rows[0]?.revision ?? 0);
}
async function apply(mutation: ConfigMutation, expected?: number) {
  return new ConfigurationRepository(pool).apply('Steven', 'kant', mutation, false, expected ?? await revision());
}
async function policy() {
  const client = await pool.connect();
  try { return await readAgentBehaviorPolicy(client, scope); } finally { client.release(); }
}
async function delivery(capabilities: string[], instance = 'policy-client') {
  const lease = await repository.acquireLease('Steven', 'argos', instance, capabilities, 30_000);
  await repository.publish(command());
  const [result] = await repository.claimDeliveries('Steven', 'argos', instance, requireValue(lease.epoch, 'epoch'), 1, 30_000);
  return { delivery: requireValue(result, 'delivery'), epoch: requireValue(lease.epoch, 'epoch'), instance };
}

beforeEach(async () => {
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='kant'");
  await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) SELECT tenant,alias,'fake',true,'policy-test','stev','/home/stev','/tmp/policy-state' FROM (VALUES('Steven','argos'),('Steven','kant'),('Pablo','seneca')) AS fixture(tenant,alias) ON CONFLICT(tenant_id,alias) DO UPDATE SET harness_id='fake',enabled=true,container_name='policy-test',runtime_user='stev',home_directory='/home/stev',state_directory='/tmp/policy-state'");
});

describe('durable behavior policy authority', () => {
  it('requires control and CAS, audits writes, and restores the policy through rollback', async () => {
    const config = new ConfigurationRepository(pool);
    await expect(config.apply('Steven', 'kant', create(), false)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(config.apply('Steven', 'argos', create(), false, await revision())).rejects.toMatchObject({ code: 'forbidden' });
    const before = await revision();
    const first = await apply(create(), before);
    await expect(apply({ resource: 'agent_behavior_policy', action: 'update', ...scope, value }, before)).rejects.toMatchObject({ code: 'conflict' });
    expect(await policy()).toEqual({ ...value, scope, revision: String(first.revision) });
    const removed = await apply({ resource: 'agent_behavior_policy', action: 'delete', ...scope });
    expect(await policy()).toBeUndefined();
    await expect(config.rollback('Steven', 'kant', removed.revision, false)).rejects.toMatchObject({ code: 'invalid_input' });
    await config.rollback('Steven', 'kant', removed.revision, false, removed.revision);
    expect(await policy()).toMatchObject({ ...value, scope });
    const audit = await pool.query("SELECT action FROM audit_events WHERE action LIKE 'config.%' ORDER BY created_at");
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(['config.change', 'config.change', 'config.rollback']);
  });

  it('serializes competing writers and rolls back previews without persistence', async () => {
    const config = new ConfigurationRepository(pool);
    const current = await revision();
    const preview = await config.apply('Steven', 'kant', create(), true, current);
    expect(preview.applied).toBe(false);
    expect(await policy()).toBeUndefined();
    const outcomes = await Promise.allSettled([apply(create(), current), apply(create(), current)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('emits only to capability aware consumers and preserves the legacy strict wire', async () => {
    await apply(create());
    const legacy = await delivery([]);
    expect(legacy.delivery).not.toHaveProperty('behavior_policy');
    expect(DeliveryEnvelopeSchema.omit({ behavior_policy: true }).strict().safeParse(legacy.delivery).success).toBe(true);
    await repository.ackDelivery(legacy.delivery.delivery_id, 'Steven', 'argos', ackWith(legacy.delivery, legacy.instance, legacy.epoch, {}));
    await repository.releaseLease('Steven', 'argos', legacy.instance, legacy.epoch);
    const capable = await delivery([AGENT_BEHAVIOR_POLICY_V1_CAPABILITY]);
    expect(capable.delivery.behavior_policy).toMatchObject({ ...value, scope });
  });

  it('keeps absent policy generic and separates identical aliases across arbitrary companies and rooms', async () => {
    expect((await delivery([AGENT_BEHAVIOR_POLICY_V1_CAPABILITY])).delivery).not.toHaveProperty('behavior_policy');
    await pool.query(`INSERT INTO tenants(id) VALUES('CompanyA'),('CompanyB');
      INSERT INTO rooms(tenant_id,id) VALUES('CompanyA','support.a'),('CompanyB','support.b'),('CompanyA','other');
      INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) SELECT tenant,'operator','fake',true,'policy-test','stev','/home/stev','/tmp/policy-state' FROM (VALUES('CompanyA'),('CompanyB')) AS fixture(tenant);
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
        ('CompanyA','support.a','operator','operator'),('CompanyB','support.b','operator','operator'),('CompanyA','other','operator','operator')`);
    await expect(new ConfigurationRepository(pool).apply('CompanyA', 'operator', {
      resource: 'agent_behavior_policy', action: 'create', tenant_id: 'CompanyB', room_id: 'support.b', alias: 'operator', value,
    }, false, await revision())).rejects.toMatchObject({ code: 'forbidden' });
    await apply({ resource: 'agent_behavior_policy', action: 'create', tenant_id: 'CompanyA', room_id: 'support.a', alias: 'operator', value });
    const client = await pool.connect();
    try {
      expect(await readAgentBehaviorPolicy(client, { tenant_id: 'CompanyA', room_id: 'support.a', alias: 'operator' })).toBeDefined();
      expect(await readAgentBehaviorPolicy(client, { tenant_id: 'CompanyB', room_id: 'support.b', alias: 'operator' })).toBeUndefined();
      expect(await readAgentBehaviorPolicy(client, { tenant_id: 'CompanyA', room_id: 'other', alias: 'operator' })).toBeUndefined();
    } finally { client.release(); }
  });

  it('rejects unauthorized escalation and fails closed after ACL, role or room revocation', async () => {
    const mutation: ConfigMutation = { resource: 'agent_behavior_policy', action: 'create', ...scope,
      value: { ...value, escalation: { coordinator: { tenant_id: 'Pablo', alias: 'seneca' } } } };
    await pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Pablo'");
    await expect(apply(mutation)).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE acl_edges SET allow_route=true WHERE from_tenant='Steven' AND to_tenant='Pablo'");
    await apply(mutation);
    expect(await policy()).toBeDefined();
    await pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Pablo'");
    expect(await policy()).toBeUndefined();
    await pool.query("UPDATE acl_edges SET allow_route=true WHERE from_tenant='Steven' AND to_tenant='Pablo'; UPDATE rooms SET enabled=false WHERE tenant_id='Steven'");
    expect(await policy()).toBeUndefined();
    await pool.query("UPDATE rooms SET enabled=true WHERE tenant_id='Steven'; UPDATE role_policies SET allow_route=false WHERE role='agent'");
    expect(await policy()).toBeUndefined();
  });

  it('binds the notice handle to the consumer and revalidates revoked egress at ACK effect', async () => {
    await grantNotifyRole('argos');
    const mutation: ConfigMutation = { resource: 'agent_behavior_policy', action: 'create', ...scope,
      value: { ...value, supervision_notice: { issuer_alias: 'kant', issuer_session_id: 'trusted-session', egress_handle: 'company.dm' } } };
    await createDestination({ alias: 'kant', handle: 'company.dm', require_prior_contact: false });
    await expect(apply(mutation)).rejects.toMatchObject({ code: 'forbidden' });
    await createDestination({ handle: 'company.dm', require_prior_contact: false });
    await apply(mutation);
    const claimed = await delivery([AGENT_BEHAVIOR_POLICY_V1_CAPABILITY]);
    expect(claimed.delivery.behavior_policy?.supervision_notice?.egress_handle).toBe('company.dm');
    await pool.query("UPDATE egress_destinations SET enabled=false WHERE tenant_id='Steven' AND alias='argos'");
    await repository.ackDelivery(claimed.delivery.delivery_id, 'Steven', 'argos', ackWith(claimed.delivery, claimed.instance, claimed.epoch,
      notifyOutput([{ to: 'company.dm', kind: 'alert', body: 'trusted notice' }])));
    expect(await notifications()).toMatchObject([{ decision: 'denied' }]);
    expect((await pool.query("SELECT id FROM adapter_outbox WHERE payload->>'relay_kind'='notify'")).rows).toHaveLength(0);
  });
  it.each(['allowed', 'issuer-agent', 'issuer-role', 'session', 'origin', 'policy-deleted', 'kind-revoked'])(
    'revalidates reserved notice authority at terminal ACK: %s', async (scenario) => {
      await grantNotifyRole('argos');
      await createDestination({ handle: 'company.dm', require_prior_contact: false });
      const configured = await apply({ resource: 'agent_behavior_policy', action: 'create', ...scope,
        value: { ...value, supervision_notice: { issuer_alias: 'kant', issuer_session_id: 'trusted-session', egress_handle: 'company.dm' } } });
      const lease = await repository.acquireLease('Steven', 'argos', 'reserved-client', [AGENT_BEHAVIOR_POLICY_V1_CAPABILITY], 30_000);
      await repository.publish(command({ body: { type: 'praxis.supervision.notice', kind: 'alert', text: 'exact notice' },
        authenticated_context: { channel: 'adapter', session_id: scenario === 'session' ? 'forged-session' : 'trusted-session',
          ...(scenario === 'origin' ? { origin: { adapter: 'telegram', channel: 'telegram', conversation_id: '123', relay: [], metadata: {} } } : {}) } }));
      const [notice] = await repository.claimDeliveries('Steven', 'argos', 'reserved-client', requireValue(lease.epoch, 'epoch'), 1, 30_000);
      const claimed = requireValue(notice, 'notice');
      if (scenario === 'issuer-agent') await pool.query("UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='kant'");
      if (scenario === 'issuer-role') {
        await pool.query("INSERT INTO role_policies(role,allow_route) VALUES('no_route',false); UPDATE memberships SET role='no_route' WHERE tenant_id='Steven' AND alias='kant'");
      }
      if (scenario === 'policy-deleted') await apply({ resource: 'agent_behavior_policy', action: 'delete', ...scope }, configured.revision);
      if (scenario === 'kind-revoked') await pool.query("UPDATE egress_destinations SET allow_kinds=ARRAY['digest']::text[] WHERE tenant_id='Steven' AND alias='argos'");
      const ack = ackWith(claimed, 'reserved-client', requireValue(lease.epoch, 'epoch'),
        notifyOutput([{ to: 'company.dm', kind: 'alert', body: 'exact notice' }]));
      await repository.ackDelivery(claimed.delivery_id, 'Steven', 'argos', ack);
      await repository.ackDelivery(claimed.delivery_id, 'Steven', 'argos', ack);
      expect(await notifications()).toMatchObject([{ decision: scenario === 'allowed' ? 'allowed' : 'denied' }]);
      expect(await notifications()).toHaveLength(1);
      expect((await pool.query("SELECT id FROM adapter_outbox WHERE payload->>'relay_kind'='notify'")).rows)
        .toHaveLength(scenario === 'allowed' ? 1 : 0);
    },
  );

  it('does not treat claimed policy or routing inventory as authority after cross tenant ACL revocation', async () => {
    await apply({ resource: 'agent_behavior_policy', action: 'create', ...scope,
      value: { ...value, escalation: { coordinator: { tenant_id: 'Pablo', alias: 'seneca' } } } });
    const claimed = await delivery([AGENT_BEHAVIOR_POLICY_V1_CAPABILITY, 'routing_targets_v1']);
    expect(claimed.delivery.routing_targets).toContainEqual(expect.objectContaining({ tenant_id: 'Pablo', alias: 'seneca' }));
    await pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Pablo'");
    await repository.ackDelivery(claimed.delivery.delivery_id, 'Steven', 'argos', ackWith(claimed.delivery, claimed.instance, claimed.epoch,
      notifyOutput([], { messages: [{ to: 'seneca', body: 'revoked route' }] })));
    expect((await pool.query("SELECT id FROM deliveries WHERE recipient_tenant='Pablo' AND recipient_alias='seneca'")).rows).toHaveLength(0);
    expect((await pool.query("SELECT status,rejection_code FROM agent_output_materializations WHERE source_delivery_id=$1", [claimed.delivery.delivery_id])).rows)
      .toEqual([{ status: 'rejected', rejection_code: 'unroutable_alias' }]);
  });

});

async function genericGateFixture() {
  await pool.query(`DELETE FROM acl_edges; UPDATE tenants SET is_hub=false WHERE is_hub; INSERT INTO tenants(id,is_hub) VALUES('CompanyA',true),('CompanyB',false);
    INSERT INTO rooms(tenant_id,id) VALUES('CompanyA','source.a'),('CompanyB','target.b');
    INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('CompanyA','source.a','operator','agent'),('CompanyB','target.b','operator','agent');
    INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
      SELECT tenant,'operator','fake',true,'policy-test','stev','/home/stev','/tmp/policy-state' FROM (VALUES('CompanyA'),('CompanyB')) fixture(tenant);
    INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route) VALUES('CompanyA','CompanyB',true,true)`);
  const nonce = 'a'.repeat(32);
  const input = command({ tenant_id: 'CompanyA', room_id: 'source.a', actor_alias: 'operator',
    recipients: [{ tenant_id: 'CompanyB', alias: 'operator' }],
    body: { type: 'system.gate.probe', nonce, timeout_ms: 5000 }, priority: -100,
    idempotency_key: `gate:CompanyB:operator:${nonce}`, authenticated_context: { session_id: 'gate-probe', channel: 'gate' } });
  const options = { systemGateProbeAuthority: { tenant_id: 'CompanyA', alias: 'gate-probe' as const,
    session_id: 'gate-probe' as const, channel: 'gate' as const } };
  return { input, options };
}

describe('generic reserved gate probe durable authority', () => {
  it('resolves a configured runtime and routes across an allowed company edge with private authority', async () => {
    const { input, options } = await genericGateFixture();
    expect(await repository.resolveSystemGateProbeActor('CompanyA', 'source.a')).toBe('operator');
    const receipt = await repository.publish(input, options);
    expect(receipt.delivery_ids).toHaveLength(1);
    const rows = await pool.query('SELECT tenant_id,actor_alias FROM messages WHERE id=$1', [receipt.message_id]);
    expect(rows.rows).toEqual([{ tenant_id: 'CompanyA', actor_alias: 'operator' }]);
  });

  it('rejects body-only authority, foreign scope, forged channel/session and unknown runtime without effects', async () => {
    const { input, options } = await genericGateFixture();
    await expect(repository.publish(input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.publish(input, { systemGateProbeAuthority: { ...options.systemGateProbeAuthority, tenant_id: 'CompanyB' } })).rejects.toMatchObject({ code: 'forbidden' });
    for (const context of [{ session_id: 'forged', channel: 'gate' }, { session_id: 'gate-probe', channel: 'adapter' }]) {
      await expect(repository.publish({ ...input, authenticated_context: context }, options)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(repository.publish({ ...input, actor_alias: 'stranger' }, options)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT id FROM messages WHERE tenant_id='CompanyA'")).rows).toHaveLength(0);
  });

  it.each(['source-runtime', 'target-runtime', 'role', 'room', 'edge'])(
    'revalidates revocation after runtime selection before publishing: %s', async (revoked) => {
      const { input, options } = await genericGateFixture();
      expect(await repository.resolveSystemGateProbeActor('CompanyA', 'source.a')).toBe('operator');
      if (revoked === 'source-runtime') await pool.query("UPDATE agents SET enabled=false WHERE tenant_id='CompanyA'");
      if (revoked === 'target-runtime') await pool.query("UPDATE agents SET enabled=false WHERE tenant_id='CompanyB'");
      if (revoked === 'role') await pool.query("UPDATE role_policies SET allow_route=false WHERE role='agent'");
      if (revoked === 'room') await pool.query("UPDATE rooms SET enabled=false WHERE tenant_id='CompanyA'");
      if (revoked === 'edge') await pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='CompanyA' AND to_tenant='CompanyB'");
      await expect(repository.publish(input, options)).rejects.toMatchObject({ code: 'forbidden' });
      expect((await pool.query("SELECT id FROM messages WHERE tenant_id='CompanyA'")).rows).toHaveLength(0);
    },
  );

  it('waits for an in-flight role revocation and denies it before the probe commits', async () => {
    const { input, options } = await genericGateFixture();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE role_policies SET allow_route=false WHERE role='agent'");
      let finished = false;
      const publishing = repository.publish(input, options).then(
        (result) => { finished = true; return result; },
        (error: unknown) => { finished = true; return error; },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      await client.query('COMMIT');
      expect(await publishing).toMatchObject({ code: 'forbidden' });
      expect((await pool.query("SELECT id FROM messages WHERE tenant_id='CompanyA'")).rows).toHaveLength(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

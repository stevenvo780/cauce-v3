import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db.js';
import {
  humanLineageConsensus, loadDeliveryHumanLineage, loadFaninHumanLineage,
  loadHumanMessageLineage, preserveHumanMessageLineage,
} from '../src/repository/human-message-lineage.js';
import { claim, claimFanin, command, pool, database, registerAgentOutputSuite, repository, terminalAck } from './agent-output-postgres-helpers.js';
import { HumanLineageRepository, lineageBranch, lineageMessage, lineageRoot, seedIdentity,
  attachLineageClient, lineageClientProjection } from './human-message-lineage-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabaseThrough } from '../../../tests/helpers/postgres.js';

registerAgentOutputSuite(import.meta.url);

describe('durable human message lineage on PostgreSQL', () => {
  it('isolates protected history between cases and only removes the database it created', async () => {
    const human = await seedIdentity(pool); const root = await lineageRoot(pool, human.humanId);
    await attachLineageClient(pool, root);
    for (const table of ['human_message_client_provenance', 'human_oauth_client_delegations', 'human_client_delegation_operations']) {
      await expect(pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow('permanent');
    }
    const next = await startTestCaseDatabase(database);
    const name = new URL(next.url).pathname.slice(1);
    try {
      expect((await next.pool.query('SELECT * FROM human_message_client_provenance')).rowCount).toBe(0);
      expect((await pool.query('SELECT * FROM human_message_client_provenance')).rowCount).toBe(1);
      await next.close(); await next.close();
      expect((await database.pool.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rowCount).toBe(0);
      expect((await pool.query('SELECT * FROM human_message_client_provenance')).rowCount).toBe(1);
    } finally { await next.close(); }
  });

  it('preserves the exact historical migration cutoff and rejects a changed server URL', async () => {
    const historical = await startTestDatabaseThrough('044_human_mcp_identity.sql');
    const originalUrl = historical.url;
    try {
      historical.url = originalUrl.replace(/\/[^/]+$/u, '/cauce');
      await expect(startTestCaseDatabase(historical)).rejects.toThrow('unchanged server');
      historical.url = originalUrl;
      const next = await startTestCaseDatabase(historical);
      try {
        expect((await next.pool.query<{ version: string }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version)
          .toBe('044_human_mcp_identity.sql');
        expect((await next.pool.query<{ name: string | null }>("SELECT to_regclass('human_message_client_provenance') AS name")).rows[0]?.name).toBeNull();
      } finally { await next.close(); }
    } finally { await historical.pool.end(); await historical.container.stop(); }
  });

  it('copies into the durable target tenant without creating cross-tenant permissions', async () => {
    const human = await seedIdentity(pool);
    const root = await lineageRoot(pool, human.humanId);
    const before = await pool.query('SELECT * FROM human_tenant_memberships ORDER BY human_id,tenant_id');
    const aclBefore = await pool.query('SELECT * FROM acl_edges ORDER BY from_tenant,to_tenant');
    const membershipsBefore = await pool.query('SELECT * FROM memberships ORDER BY tenant_id,room_id,alias');
    await withTransaction(pool, async (client) => {
      const child = await lineageMessage(client, 'Jhon');
      await preserveHumanMessageLineage(client, child, root);
      expect(await loadHumanMessageLineage(client, child)).toEqual({
        ...root, messageId: child, messageTenantId: 'Jhon',
      });
      await preserveHumanMessageLineage(client, child, root, true);
    });
    expect((await pool.query('SELECT * FROM human_tenant_memberships ORDER BY human_id,tenant_id')).rows).toEqual(before.rows);
    expect((await pool.query('SELECT * FROM acl_edges ORDER BY from_tenant,to_tenant')).rows).toEqual(aclBefore.rows);
    expect((await pool.query('SELECT * FROM memberships ORDER BY tenant_id,room_id,alias')).rows).toEqual(membershipsBefore.rows);
  });

  it('requires all durable fan-in branches and leaves partial unknown unattributed', async () => {
    const human = await seedIdentity(pool);
    const root = await lineageRoot(pool, human.humanId);
    await withTransaction(pool, async (client) => {
      const first = await lineageMessage(client);
      await preserveHumanMessageLineage(client, first, root);
      const delivery = await lineageBranch(client, root.messageId, first);
      expect(await loadDeliveryHumanLineage(client, delivery)).toMatchObject({ humanId: human.humanId });
      expect(await loadFaninHumanLineage(client, root.messageId)).toEqual(root);
      const unknown = await lineageMessage(client);
      await lineageBranch(client, root.messageId, unknown);
      expect(await loadFaninHumanLineage(client, root.messageId)).toBeUndefined();
      await preserveHumanMessageLineage(client, unknown, undefined);
      expect(await loadHumanMessageLineage(client, unknown)).toBeUndefined();
    });
  });

  it('leaves an entirely unknown durable fan-in unattributed', async () => {
    await withTransaction(pool, async (client) => {
      const root = await lineageMessage(client);
      const child = await lineageMessage(client);
      await lineageBranch(client, root, child);
      expect(await loadFaninHumanLineage(client, root)).toBeUndefined();
    });
  });

  it('aborts different roots even for the same human and preserves two UUIDs sharing an alias', async () => {
    const first = await seedIdentity(pool);
    const second = await seedIdentity(pool, first.alias);
    const a = await lineageRoot(pool, first.humanId);
    const b = await lineageRoot(pool, first.humanId);
    const c = await lineageRoot(pool, second.humanId);
    expect(() => humanLineageConsensus([a, b])).toThrow('lineage disagrees');
    expect(() => humanLineageConsensus([undefined, a, c])).toThrow('lineage disagrees');
    expect(humanLineageConsensus([undefined, a])).toBeUndefined();
    expect(humanLineageConsensus([undefined, undefined])).toBeUndefined();
    await expect(withTransaction(pool, async (client) => {
      await lineageBranch(client, a.messageId, b.messageId);
      await loadFaninHumanLineage(client, a.messageId);
    })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not repair existing unknown targets or overwrite existing owners', async () => {
    const human = await seedIdentity(pool);
    const root = await lineageRoot(pool, human.humanId);
    const other = await lineageRoot(pool, human.humanId);
    const target = await withTransaction(pool, (client) => lineageMessage(client));
    await expect(withTransaction(pool, (client) => preserveHumanMessageLineage(client, target, root, true)))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(withTransaction(pool, (client) => preserveHumanMessageLineage(client, root.messageId, other)))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(withTransaction(pool, (client) => preserveHumanMessageLineage(client, root.messageId, undefined, true)))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('rolls back the message and provenance together', async () => {
    const human = await seedIdentity(pool);
    const root = await lineageRoot(pool, human.humanId);
    let child = '';
    await expect(withTransaction(pool, async (client) => {
      child = await lineageMessage(client);
      await preserveHumanMessageLineage(client, child, root);
      throw new Error('fixture rollback');
    })).rejects.toThrow('fixture rollback');
    expect((await pool.query('SELECT id FROM messages WHERE id=$1', [child])).rowCount).toBe(0);
    expect((await pool.query('SELECT message_id FROM human_message_initiators WHERE message_id=$1', [child])).rowCount).toBe(0);
  });

  it('propagates through output, response, continuation, fan-in and repeated ACKs', async () => {
    const human = await seedIdentity(pool);
    const claimed = await claim(command(), 'Steven', 'argos', 'lineage-output');
    const root = await lineageRoot(pool, human.humanId, claimed.delivery.message_id);
    const clientProjection = await attachLineageClient(pool, root);
    const ack = terminalAck(claimed.delivery, 'lineage-output', claimed.epoch, [{ to: 'kant', body: 'ordinary delegation' }]);
    await repository.ackDelivery(claimed.delivery.delivery_id, 'Steven', 'argos', ack);
    await repository.ackDelivery(claimed.delivery.delivery_id, 'Steven', 'argos', ack);
    const children = await pool.query<{ produced_message_id: string }>(
      'SELECT produced_message_id FROM agent_output_materializations WHERE source_delivery_id=$1 AND status=$2',
      [claimed.delivery.delivery_id, 'materialized'],
    );
    expect(children.rows).toHaveLength(1);
    const lease = await repository.acquireLease('Steven', 'kant', 'lineage-child', [], 30_000);
    if (lease.epoch === undefined) throw new Error('missing child epoch');
    const [childDelivery] = await repository.claimDeliveries('Steven', 'kant', 'lineage-child', lease.epoch, 1, 30_000);
    if (!childDelivery) throw new Error('missing child delivery');
    await repository.ackDelivery(childDelivery.delivery_id, 'Steven', 'kant',
      terminalAck(childDelivery, 'lineage-child', lease.epoch, [{ to: 'socrates', body: 'ordinary nested work' }]));
    const leafLease = await repository.acquireLease('Steven', 'socrates', 'lineage-leaf', [], 30_000);
    if (leafLease.epoch === undefined) throw new Error('missing leaf epoch');
    const [leaf] = await repository.claimDeliveries('Steven', 'socrates', 'lineage-leaf', leafLease.epoch, 1, 30_000);
    if (!leaf) throw new Error('missing leaf delivery');
    await repository.ackDelivery(leaf.delivery_id, 'Steven', 'socrates',
      terminalAck(leaf, 'lineage-leaf', leafLease.epoch, []));
    const [continuation] = await repository.claimDeliveries('Steven', 'kant', 'lineage-child', lease.epoch, 1, 30_000);
    if (!continuation) throw new Error('missing continuation');
    expect(continuation.body.type).toBe('agent.response');
    await repository.ackDelivery(continuation.delivery_id, 'Steven', 'kant',
      terminalAck(continuation, 'lineage-child', lease.epoch, []));
    const [response] = await repository.claimDeliveries('Steven', 'argos', 'lineage-output', claimed.epoch, 1, 30_000);
    if (!response) throw new Error('missing response delivery');
    expect(response.body.type).toBe('agent.response');
    await repository.ackDelivery(response.delivery_id, 'Steven', 'argos',
      terminalAck(response, 'lineage-output', claimed.epoch, []));
    const repeated = await withTransaction(pool, (client) =>
      new HumanLineageRepository(pool).materializeExistingFanin(client, root.messageId));
    expect(repeated).toEqual({ hasFanout: true, scheduled: true });
    const fanin = await claimFanin('Steven', 'argos', 'lineage-output', claimed.epoch);
    await withTransaction(pool, async (client) => {
      for (const id of [leaf.message_id, continuation.message_id, response.message_id, fanin.message_id]) {
        expect(await loadHumanMessageLineage(client, id)).toEqual({ ...root, messageId: id });
        expect(await lineageClientProjection(client, id)).toEqual(clientProjection);
      }
    });
    await withTransaction(pool, async (client) => {
      for (const child of children.rows) {
        expect(await loadHumanMessageLineage(client, child.produced_message_id)).toEqual({
          ...root, messageId: child.produced_message_id,
        });
        expect(await lineageClientProjection(client, child.produced_message_id)).toEqual(clientProjection);
      }
    });
  });

  it('retains the canonical owner when ordinary failures coalesce into an existing notice', async () => {
    await pool.query(`UPDATE agent_chain_policies
      SET failure_coalesce_enabled=true,failure_coalesce_window_seconds=900 WHERE id='default'`);
    const human = await seedIdentity(pool);
    const claimed = await claim(command(), 'Steven', 'argos', 'lineage-coalescing');
    const root = await lineageRoot(pool, human.humanId, claimed.delivery.message_id);
    await repository.ackDelivery(claimed.delivery.delivery_id, 'Steven', 'argos',
      terminalAck(claimed.delivery, 'lineage-coalescing', claimed.epoch, [
        { to: 'kant', body: 'first ordinary work' }, { to: 'kant', body: 'second ordinary work' },
      ]));
    const lease = await repository.acquireLease('Steven', 'kant', 'lineage-failure', [], 30_000);
    if (lease.epoch === undefined) throw new Error('missing failure epoch');
    const children = await repository.claimDeliveries('Steven', 'kant', 'lineage-failure', lease.epoch, 10, 30_000);
    expect(children).toHaveLength(2);
    for (const child of children) {
      await repository.ackDelivery(child.delivery_id, 'Steven', 'kant', {
        version: '3.0', event_id: randomUUID(), status: 'failed', instance_id: 'lineage-failure',
        epoch: lease.epoch, claim_token: child.claim_token, attempt: child.attempt,
        retryable: false, error: 'ordinary fixture failure', error_code: 'PROCESS_EXIT',
      });
    }
    const notices = await pool.query<{ last_notice_message_id: string; total_failures: number }>(
      'SELECT last_notice_message_id,total_failures FROM agent_failure_notices WHERE root_message_id=$1',
      [root.messageId],
    );
    expect(notices.rows).toHaveLength(1);
    const notice = notices.rows[0];
    if (!notice) throw new Error('missing failure notice');
    expect(notice.total_failures).toBe(2);
    await withTransaction(pool, async (client) => {
      expect(await loadHumanMessageLineage(client, notice.last_notice_message_id)).toEqual({
        ...root, messageId: notice.last_notice_message_id,
      });
    });
    expect((await pool.query(`SELECT * FROM agent_failure_notice_events
      WHERE coalesced=true AND notice_message_id=$1`, [notice.last_notice_message_id])).rowCount).toBe(1);
  });

});

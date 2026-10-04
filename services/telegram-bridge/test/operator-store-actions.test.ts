import { describe, expect, it } from 'vitest';
import { createStoreOperatorActions } from '../src/operator-commands/store-actions.js';
import { StoreError } from '@cauce/store';
import type { PublishMessage } from '@cauce/protocol';

describe('createStoreOperatorActions', () => {
  it('maps fleet rows and drops malformed agents', async () => {
    const actions = createStoreOperatorActions({
      async fleetActivity() {
        return {
          agents: [
            { tenant_id: 'Steven', alias: 'zeus', work_state: 'stalled', flags: ['claimed_not_started'],
              in_flight: 1, queued: 0, retrying: 0, overdue_in_flight: 1, claimed_not_started: 1,
              seconds_since_last_ack: 40, presence: { online: true } },
            { alias: 'broken' },
            'no'
          ]
        };
      },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { schemaVersion: 1, items: [], total: 0, truncated: false, nextCursor: null }; }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });
    const agents = await actions.listFleet('Steven', 'kant');
    expect(agents).toEqual([{
      tenant_id: 'Steven', alias: 'zeus', work_state: 'stalled', flags: ['claimed_not_started'],
      in_flight: 1, queued: 0, retrying: 0, overdue_in_flight: 1, claimed_not_started: 1,
      seconds_since_last_ack: 40, presence_online: true
    }]);
  });

  it('maps queue totals and rows while refusing malformed deliveries', async () => {
    let queue: unknown = {
      totals: { pending: '2', retrying: 1, dead: 0 },
      items: [
        { delivery_id: 'delivery-1', recipient_alias: 'zeus', state: 'retrying', attempts: 3, last_error: 'timeout' },
        { delivery_id: 'delivery-2', recipient_alias: 'janus', state: 7, attempts: Number.NaN, last_error: 8 },
        { delivery_id: 9, recipient_alias: 'broken' },
        null
      ]
    };
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return queue; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { items: [] }; }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });

    await expect(actions.listQueue('Steven', 'kant')).resolves.toEqual({
      totals: { pending: '2', retrying: 1, dead: 0 },
      items: [
        { delivery_id: 'delivery-1', recipient_alias: 'zeus', state: 'retrying', attempts: 3, last_error: 'timeout' },
        { delivery_id: 'delivery-2', recipient_alias: 'janus', state: 'unknown', attempts: 0, last_error: null }
      ]
    });
    queue = null;
    await expect(actions.listQueue('Steven', 'kant')).resolves.toEqual({ items: [] });
  });

  it('lists only open actionable telegram origin_relay incidents', async () => {
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() {
        return {
          schemaVersion: 1,
          total: 3,
          truncated: false,
          nextCursor: null,
          items: [
            { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'origin_relay', adapter: 'telegram',
              disposition: 'ambiguous', open: true, actionable: true, evidenceSha256: 'ab'.repeat(32),
              attempts: 1, tenantId: 'Steven', resolutionRule: null, createdAt: '', dispositionAt: null,
              resolvedAt: null, reopenCount: 0, lastReopenedAt: null },
            { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'origin_relay', adapter: 'console',
              disposition: 'ambiguous', open: true, actionable: true, evidenceSha256: 'cd'.repeat(32),
              attempts: 1, tenantId: 'Steven', resolutionRule: null, createdAt: '', dispositionAt: null,
              resolvedAt: null, reopenCount: 0, lastReopenedAt: null },
            { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'wake', adapter: 'gateway',
              disposition: 'safe_retry', open: true, actionable: true, evidenceSha256: 'ef'.repeat(32),
              attempts: 1, tenantId: 'Steven', resolutionRule: null, createdAt: '', dispositionAt: null,
              resolvedAt: null, reopenCount: 0, lastReopenedAt: null }
          ]
        };
      }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });
    const items = await actions.listStuckEgress('Steven', 'kant');
    expect(items.map((item) => item.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it('refuses inspect without a sha256', async () => {
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { schemaVersion: 1, items: [], total: 0, truncated: false, nextCursor: null }; }
    }, {
      async inspectTelegramReplay() { throw new Error('should not run'); },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });
    await expect(actions.inspectTelegramReplay(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'nope', 'Steven', 'kant'
    )).rejects.toBeInstanceOf(StoreError);
  });

  it('publishes a canonical nudge with trusted actor context and returns duplicate status', async () => {
    const published: PublishMessage[] = [];
    const responses = [false, true];
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish(input) {
        published.push(input);
        return { duplicate: responses.shift() ?? false };
      },
      async listOperationalDlq() { return { items: [] }; }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });
    const input = {
      actorTenant: 'Steven', actorAlias: 'kant', roomId: 'grp.steven',
      targetTenant: 'Steven', targetAlias: 'zeus', botId: '900001', updateId: 44
    };

    expect(await actions.nudge(input)).toEqual({ duplicate: false });
    expect(await actions.nudge(input)).toEqual({ duplicate: true });
    expect(published).toHaveLength(2);
    expect(published[0]).toEqual(published[1]);
    expect(published[0]).toMatchObject({
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Steven', alias: 'zeus' }],
      idempotency_key: 'telegram-nudge:900001:44',
      lane: 'interactive',
      authenticated_context: { session_id: 'tg-operator:900001', channel: 'telegram' },
      body: {
        type: 'telegram.operator.nudge',
        text: 'Nudge del operador: seguí el trabajo en curso o contestá lo pendiente.',
        prompt: 'Nudge del operador: seguí el trabajo en curso o contestá lo pendiente.'
      }
    });
    expect(published[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(published[0]?.trace_id).toMatch(/^telegram-nudge-[0-9a-f]{32}$/);
  });

  it('forwards valid incident evidence and replay fencing inputs without weakening malformed-input guards', async () => {
    const inspectionCalls: unknown[][] = [];
    const replayCalls: unknown[][] = [];
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return {}; },
      async cancelDelivery() { return {}; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { items: [] }; }
    }, {
      async inspectTelegramReplay(...args) {
        inspectionCalls.push(args);
        return { evidenceSha256: 'ab'.repeat(32), items: [] };
      },
      async manualReplayEffect(...args) {
        replayCalls.push(args);
        return { state: 'prepared', replay_count: 2 };
      }
    });
    const letterId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const evidence = 'ab'.repeat(32);

    await expect(actions.inspectTelegramReplay('bad-id', evidence, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(actions.inspectTelegramReplay(letterId, 'bad-hash', 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(inspectionCalls).toEqual([]);
    await expect(actions.inspectTelegramReplay(letterId, evidence, 'Steven', 'kant'))
      .resolves.toEqual({ evidenceSha256: evidence, items: [] });
    expect(inspectionCalls).toEqual([[letterId, evidence, 'Steven', 'kant']]);

    await expect(actions.replayTelegramEgress({
      chunkIndex: 2, payloadHash: 'cd'.repeat(32), reason: 'operador confirma',
      actorTenant: 'Steven', actorAlias: 'kant', duplicateRiskAcknowledged: true,
      botId: '900001', updateId: 44, deadLetterId: letterId,
      incidentEvidenceSha256: evidence, expectedReplayCount: 1
    })).resolves.toEqual({ state: 'prepared', replay_count: 2 });
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]).toMatchObject([
      2, 'cd'.repeat(32), 'operador confirma', 'Steven', 'kant', true,
      expect.stringMatching(/^[0-9a-f-]{36}$/i), letterId, evidence, 1
    ]);
  });

  it('rejects malformed replay and cancel results instead of acknowledging an empty ID', async () => {
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery() { return { delivery_id: 42 }; },
      async cancelDelivery() { return { state: 'dead' }; },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { items: [] }; }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });

    await expect(actions.replayDelivery('delivery-1', 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(actions.cancelDelivery('delivery-1', 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('forwards actor scope and reason for replay/cancel and normalizes a missing cancel state', async () => {
    const calls: unknown[][] = [];
    const actions = createStoreOperatorActions({
      async fleetActivity() { return { agents: [] }; },
      async queueSnapshot() { return {}; },
      async replayDelivery(...args) {
        calls.push(['replay', ...args]);
        return { delivery_id: 'delivery-clone' };
      },
      async cancelDelivery(...args) {
        calls.push(['cancel', ...args]);
        return { delivery_id: 'delivery-original' };
      },
      async publish() { return { duplicate: false }; },
      async listOperationalDlq() { return { items: [] }; }
    }, {
      async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
      async manualReplayEffect() { return { state: 'prepared', replay_count: 1 }; }
    });

    await expect(actions.replayDelivery('delivery-original', 'Steven', 'kant'))
      .resolves.toEqual({ delivery_id: 'delivery-clone' });
    await expect(actions.cancelDelivery('delivery-original', 'Steven', 'kant', 'duplicada'))
      .resolves.toEqual({ delivery_id: 'delivery-original', state: 'dead' });
    expect(calls).toEqual([
      ['replay', 'delivery-original', 'Steven', 'kant'],
      ['cancel', 'delivery-original', 'Steven', 'kant', 'duplicada']
    ]);
  });
});

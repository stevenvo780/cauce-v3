import { describe, expect, it } from 'vitest';
import { createStoreOperatorActions } from '../src/operator-commands/store-actions.js';
import { StoreError } from '@cauce/store';

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
});

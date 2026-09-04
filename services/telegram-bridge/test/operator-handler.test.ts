import { describe, expect, it } from 'vitest';
import { handleOperatorCommand } from '../src/operator-commands/handler.js';
import type { OperatorActions } from '../src/operator-commands/dispatch.js';
import { config } from './bridge-fixtures.js';

const touched: string[] = [];

const actions: OperatorActions = {
  async listFleet() { touched.push('listFleet'); return []; },
  async listQueue() { return { items: [] }; },
  async replayDelivery() {
    touched.push('replayDelivery');
    return { delivery_id: '22222222-2222-4222-8222-222222222222' };
  },
  async cancelDelivery(deliveryId) { return { delivery_id: deliveryId, state: 'dead' }; },
  async nudge() { return { duplicate: false }; },
  async listStuckEgress() { return []; },
  async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
  async replayTelegramEgress() { return { state: 'prepared', replay_count: 1 }; }
};

const enabled = config({
  operator_commands: true,
  operator_user_ids: ['101'],
  allowed_user_ids: ['101', '202']
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    config: enabled,
    botId: '900001',
    userId: '101',
    privateChat: true,
    text: '/estado',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    updateId: 9,
    actions,
    ...overrides
  };
}

describe('handleOperatorCommand', () => {
  it('ignores groups, opted-out aliases and non-operator users', async () => {
    expect((await handleOperatorCommand(request({ privateChat: false }))).kind).toBe('ignored');
    expect((await handleOperatorCommand(request({ config: config() }))).kind).toBe('ignored');
    expect((await handleOperatorCommand(request({ userId: '202' }))).kind).toBe('ignored');
  });

  it('ignores an allowlisted operator while the alias has not opted in', async () => {
    const absent = config({ operator_user_ids: ['101'], allowed_user_ids: ['101', '202'] });
    const disabled = config({
      operator_commands: false, operator_user_ids: ['101'], allowed_user_ids: ['101', '202']
    });
    touched.length = 0;

    expect((await handleOperatorCommand(request({ config: absent }))).kind).toBe('ignored');
    expect((await handleOperatorCommand(request({
      config: disabled,
      text: '/replay 11111111-1111-4111-8111-111111111111',
      entities: [{ type: 'bot_command', offset: 0, length: 7 }]
    }))).kind).toBe('ignored');
    expect(touched).toEqual([]);
  });

  it('ignores ordinary private text so the agent still receives it', async () => {
    expect((await handleOperatorCommand(request({ text: 'hola', entities: undefined }))).kind)
      .toBe('ignored');
  });

  it('handles a leading command from the operator and does not throw on /start', async () => {
    const estado = await handleOperatorCommand(request());
    expect(estado).toMatchObject({ kind: 'handled', command: 'estado' });
    if (estado.kind !== 'handled') throw new Error('expected handled');
    expect(estado.reply.length).toBeGreaterThan(0);

    const start = await handleOperatorCommand(request({
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }));
    expect(start).toMatchObject({ kind: 'handled', command: 'unknown' });
  });
});

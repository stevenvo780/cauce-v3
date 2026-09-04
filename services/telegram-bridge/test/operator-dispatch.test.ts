import { describe, expect, it } from 'vitest';
import { dispatchOperatorCommand } from '../src/operator-commands/dispatch.js';
import type { OperatorActions, OperatorDispatchContext } from '../src/operator-commands/dispatch.js';
import type { OperatorCommand } from '../src/operator-commands/parse.js';
import { StoreError } from '@cauce/store';

const CTX: OperatorDispatchContext = {
  actorTenant: 'Steven',
  actorAlias: 'kant',
  roomId: 'grp.steven',
  botId: '900001',
  updateId: 44
};

function actions(overrides: Partial<OperatorActions> = {}): OperatorActions & { calls: string[] } {
  const calls: string[] = [];
  const base: OperatorActions & { calls: string[] } = {
    calls,
    async listFleet() {
      calls.push('listFleet');
      return [
        {
          tenant_id: 'Steven', alias: 'zeus', work_state: 'stalled', flags: ['claimed_not_started'],
          in_flight: 1, queued: 2, retrying: 0, overdue_in_flight: 1, claimed_not_started: 1,
          seconds_since_last_ack: 900, presence_online: true
        },
        {
          tenant_id: 'Steven', alias: 'kant', work_state: 'idle', flags: [],
          in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0, claimed_not_started: 0,
          seconds_since_last_ack: 3, presence_online: true
        }
      ];
    },
    async listQueue() {
      calls.push('listQueue');
      return {
        totals: { pending: 1, retrying: 0, dead: 2 },
        items: [
          { delivery_id: '11111111-1111-4111-8111-111111111111', recipient_alias: 'zeus', state: 'dead', attempts: 3, last_error: 'boom' }
        ]
      };
    },
    async replayDelivery(deliveryId) {
      calls.push(`replay:${deliveryId}`);
      return { delivery_id: '22222222-2222-4222-8222-222222222222' };
    },
    async cancelDelivery(deliveryId, _tenant, _alias, reason) {
      calls.push(`cancel:${deliveryId}:${reason ?? ''}`);
      return { delivery_id: deliveryId, state: 'dead' };
    },
    async nudge(input) {
      calls.push(`nudge:${input.targetAlias}`);
      return { duplicate: false };
    },
    async listStuckEgress() {
      calls.push('listStuckEgress');
      return [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'origin_relay',
        adapter: 'telegram',
        disposition: 'ambiguous',
        open: true,
        actionable: true,
        evidenceSha256: 'ab'.repeat(32),
        attempts: 1
      }];
    },
    async inspectTelegramReplay(letterId) {
      calls.push(`inspect:${letterId}`);
      return {
        evidenceSha256: 'ab'.repeat(32),
        items: [{ chunkIndex: 0, effectSha256: 'cd'.repeat(32), state: 'ambiguous', replayCount: 0, duplicateRisk: true }]
      };
    },
    async replayTelegramEgress(input) {
      calls.push(`replayTelegram:${input.deadLetterId}:${String(input.duplicateRiskAcknowledged)}`);
      return { state: 'prepared', replay_count: 1 };
    }
  };
  return { ...base, ...overrides, calls };
}

async function run(
  command: OperatorCommand, port = actions()
): Promise<{ text: string; failed: boolean; calls: string[] }> {
  const { text, failed } = await dispatchOperatorCommand(command, CTX, port);
  return { text, failed, calls: port.calls };
}

describe('dispatchOperatorCommand', () => {
  it('ayuda lists the live commands and says there is no /on', async () => {
    const { text, calls } = await run({ name: 'ayuda' });
    expect(calls).toEqual([]);
    expect(text).toContain('/estado');
    expect(text).toContain('/forzar_salida');
    expect(text).toContain('No hay /on ni /off');
  });

  it('estado without alias summarises the visible fleet', async () => {
    const { text } = await run({ name: 'estado' });
    expect(text).toContain('zeus');
    expect(text).toContain('stalled');
    expect(text).toContain('kant');
  });

  it('trabados only names stalled aliases', async () => {
    const { text } = await run({ name: 'trabados' });
    expect(text).toContain('zeus');
    expect(text).not.toContain('kant ·');
  });

  it('replay calls the durable replay and names the clone', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const { text, calls } = await run({ name: 'replay', deliveryId: id });
    expect(calls).toEqual([`replay:${id}`]);
    expect(text).toContain('22222222');
  });

  it('replay maps a store not_found into Spanish without leaking a stack', async () => {
    const port = actions({
      async replayDelivery() { throw new StoreError('not_found', 'delivery not found or not visible'); }
    });
    const { text, calls } = await run({ name: 'replay', deliveryId: '11111111-1111-4111-8111-111111111111' }, port);
    expect(calls.filter((entry) => entry.startsWith('replay:'))).toHaveLength(0);
    expect(text).toMatch(/no encontré|permiso/i);
    expect(text).not.toContain('delivery not found or not visible');
  });

  it('nudge refuses an alias the actor cannot see', async () => {
    const { text, calls } = await run({ name: 'nudge', alias: 'janus' });
    expect(calls).toEqual(['listFleet']);
    expect(text).toMatch(/no (veo|encontr)/i);
  });

  it('nudge publishes to a visible alias', async () => {
    const { text, calls } = await run({ name: 'nudge', alias: 'zeus' });
    expect(calls).toContain('nudge:zeus');
    expect(text).toMatch(/wake|encolada|zeus/i);
  });

  it('forzar_salida without id lists actionable telegram origin_relay rows', async () => {
    const { text, calls } = await run({ name: 'forzar_salida', duplicateOk: false });
    expect(calls).toEqual(['listStuckEgress']);
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('duplicado-ok');
  });

  it('forzar_salida with id and without duplicado-ok inspects and does not replay', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { text, calls } = await run({ name: 'forzar_salida', letterId: id, duplicateOk: false });
    expect(calls).toEqual(['listStuckEgress', `inspect:${id}`]);
    expect(calls.some((entry) => entry.startsWith('replayTelegram:'))).toBe(false);
    expect(text).toContain('duplicado-ok');
    expect(text).toContain('ambiguous');
  });

  it('forzar_salida with duplicado-ok replays the inspected chunk', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { text, calls } = await run({ name: 'forzar_salida', letterId: id, duplicateOk: true });
    expect(calls).toContain(`replayTelegram:${id}:true`);
    expect(text).toMatch(/reencol/i);
  });

  it('unknown commands return help instead of throwing', async () => {
    const { text, calls } = await run({ name: 'unknown', raw: 'start' });
    expect(calls).toEqual([]);
    expect(text).toContain('/ayuda');
    expect(text).toContain('start');
  });

  it('maps an unmapped StoreError code to Spanish without its message or stack', async () => {
    const port = actions({
      async replayDelivery() {
        throw new StoreError(
          'rate_limited',
          'FATAL: password authentication failed for user "cauce" at 10.0.0.5:5432'
        );
      }
    });
    const { text } = await run({ name: 'replay', deliveryId: '11111111-1111-4111-8111-111111111111' }, port);
    expect(text).toContain('La acción durable falló');
    expect(text).not.toContain('password');
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('StoreError');
    expect(text).not.toContain('at ');
  });

  it('does not echo a plain store Error either', async () => {
    const port = actions({
      async cancelDelivery() { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); }
    });
    const { text } = await run(
      { name: 'cancelar', deliveryId: '11111111-1111-4111-8111-111111111111' }, port
    );
    expect(text).toContain('La acción durable falló');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.0.0.5');
  });

  it('never inspects a letterId absent from the actor own DLQ page', async () => {
    const { text, calls } = await run(
      { name: 'forzar_salida', letterId: '99999999-9999-4999-8999-999999999999', duplicateOk: true }
    );
    expect(calls).toEqual(['listStuckEgress']);
    expect(text).toContain('No veo ese incidente');
  });

  it('refuses an incident without evidence sha before reaching the inspect RPC', async () => {
    const port = actions({
      async listStuckEgress() {
        return [{
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kind: 'origin_relay', adapter: 'telegram', disposition: 'ambiguous',
          open: true, actionable: true, evidenceSha256: null, attempts: 1
        }];
      }
    });
    const { text, calls } = await run(
      { name: 'forzar_salida', letterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', duplicateOk: true },
      port
    );
    expect(calls.some((entry) => entry.startsWith('inspect:'))).toBe(false);
    expect(text).toContain('no trajo evidencia SHA-256');
  });

  it('duplicado-ok on a multi-chunk incident replays nothing and sends to the console', async () => {
    const port = actions({
      async inspectTelegramReplay() {
        return {
          evidenceSha256: 'ab'.repeat(32),
          items: [
            { chunkIndex: 0, effectSha256: 'cd'.repeat(32), state: 'ambiguous', replayCount: 0, duplicateRisk: true },
            { chunkIndex: 1, effectSha256: 'ef'.repeat(32), state: 'ambiguous', replayCount: 0, duplicateRisk: true }
          ]
        };
      }
    });
    const { text, calls } = await run(
      { name: 'forzar_salida', letterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', duplicateOk: true },
      port
    );
    expect(calls.some((entry) => entry.startsWith('replayTelegram:'))).toBe(false);
    expect(text).toContain('más de un chunk');
  });

  it('duplicado-ok on an incident with no chunks replays nothing', async () => {
    const port = actions({
      async inspectTelegramReplay() {
        return { evidenceSha256: 'ab'.repeat(32), items: [] };
      }
    });
    const { text, calls } = await run(
      { name: 'forzar_salida', letterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', duplicateOk: true },
      port
    );
    expect(calls.some((entry) => entry.startsWith('replayTelegram:'))).toBe(false);
    expect(text).toContain('no trajo chunks inspeccionables');
  });

  it('clips a long answer to the telegram cap instead of letting sendText reject it', async () => {
    const port = actions({
      async listFleet() {
        return Array.from({ length: 500 }, (_value, index) => ({
          tenant_id: 'Steven', alias: `alias-${String(index)}`, work_state: 'idle',
          flags: ['claimed_not_started'], in_flight: 1, queued: 2, retrying: 0,
          overdue_in_flight: 0, claimed_not_started: 1, seconds_since_last_ack: 1,
          presence_online: true
        }));
      }
    });
    const { text } = await run({ name: 'estado' }, port);
    expect(Array.from(text).length).toBe(4_096);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('dispatchOperatorCommand reports whether the durable action worked', () => {
  it('a store refusal answered in Spanish is still a failed command', async () => {
    const { text, failed } = await run(
      { name: 'replay', deliveryId: '11111111-1111-4111-8111-111111111111' },
      actions({ async replayDelivery() { throw new StoreError('conflict', 'not replayable'); } })
    );
    expect(failed).toBe(true);
    expect(text).not.toContain('not replayable');
  });

  it('a help text and a successful replay are not failures', async () => {
    expect((await run({ name: 'ayuda' })).failed).toBe(false);
    expect((await run({ name: 'replay', deliveryId: '11111111-1111-4111-8111-111111111111' })).failed).toBe(false);
  });
});

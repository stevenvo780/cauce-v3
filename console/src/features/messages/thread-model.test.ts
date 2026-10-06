import { describe, expect, it } from 'vitest';
import type { DeliveryState, MessageView } from '../../api/types';
import type { TranscriptItem } from '../terminal/session';
import { dayLabel, threadRows, typingState } from './thread-model';
import type { CanonicalReply } from './use-canonical-reply';

const NOW = Date.parse('2026-10-06T15:00:00');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function input(id: string, status: DeliveryState | null, createdAt = at(-60_000)): TranscriptItem {
  const message: MessageView = { message_id: id, tenant_id: 'Steven', actor_alias: 'kant', body_preview: id, created_at: createdAt };
  return { message, direction: 'input', delivery: { delivery_id: `d-${id}`, recipient_tenant: 'Steven', recipient_alias: 'argos', status } };
}

function output(id: string, createdAt = at(-30_000)): TranscriptItem {
  return { message: { message_id: id, tenant_id: 'Steven', actor_alias: 'argos', body_preview: id, created_at: createdAt }, direction: 'output' };
}

function reply(root: TranscriptItem, overrides: Partial<CanonicalReply> = {}): CanonicalReply {
  return {
    messageId: root.message.message_id ?? '', deliveryId: root.delivery?.delivery_id ?? '',
    tenantId: 'Steven', alias: 'argos', chainOpen: false, status: 'done', reply: 'hecho', ...overrides,
  };
}

describe('typingState', () => {
  it.each([
    ['leased', 'thinking'], ['accepted', 'thinking'], ['started', 'thinking'],
    ['pending', 'receiving'], ['retry', 'receiving'],
  ] as const)('una entrega %s sin respuesta se dibuja como %s', (status, expected) => {
    expect(typingState({ items: [input('m1', status)], live: 'idle' })).toBe(expected);
  });

  it.each(['done', 'failed', 'dead'] as const)('una entrega %s ya no escribe', (status) => {
    expect(typingState({ items: [input('m1', status)], live: 'thinking' })).toBeUndefined();
  });

  it('desaparece cuando llega la respuesta del agente, por mensaje propio o por respuesta canónica', () => {
    const root = input('m1', 'started');
    expect(typingState({ items: [root, output('r1')], live: 'thinking' })).toBeUndefined();
    expect(typingState({ items: [root], reply: reply(root), live: 'thinking' })).toBeUndefined();
  });

  it('una respuesta parcial o de otro alcance no la apaga', () => {
    const root = input('m1', 'started');
    expect(typingState({ items: [root], reply: reply(root, { chainOpen: true }) })).toBe('thinking');
    expect(typingState({ items: [root], reply: reply(root, { alias: 'otro' }) })).toBe('thinking');
  });

  it('un agente caído o trabado nunca aparenta escribir', () => {
    expect(typingState({ items: [input('m1', 'started')], live: 'down' })).toBeUndefined();
    expect(typingState({ items: [input('m1', 'pending')], live: 'blocked' })).toBeUndefined();
  });

  it('sin estado de entrega sólo el estado vivo decide', () => {
    expect(typingState({ items: [input('m1', null)], live: 'thinking' })).toBe('thinking');
    expect(typingState({ items: [input('m1', null)], live: 'receiving' })).toBe('receiving');
    expect(typingState({ items: [input('m1', null)], live: 'idle' })).toBeUndefined();
  });

  it('un hilo vacío o terminado en un mensaje del agente no escribe', () => {
    expect(typingState({ items: [], live: 'thinking' })).toBeUndefined();
    expect(typingState({ items: [output('r1')], live: 'thinking' })).toBeUndefined();
  });
});

describe('threadRows', () => {
  it('separa por día y agrupa mensajes seguidos del mismo autor', () => {
    const items = [
      input('ayer', 'done', at(-24 * 3_600_000)),
      input('hoy-1', 'done', at(-10 * 60_000)),
      input('hoy-2', 'done', at(-9 * 60_000)),
      output('respuesta', at(-8 * 60_000)),
      input('tarde', 'done', at(-60_000)),
    ];
    const rows = threadRows(items, undefined, NOW);
    expect(rows.map((row) => row.kind === 'day' ? `día:${row.label}` : `${row.key}:${String(row.startsGroup)}`)).toEqual([
      'día:Ayer', 'ayer:true', 'día:Hoy', 'hoy-1:true', 'hoy-2:false', 'respuesta:true', 'tarde:true',
    ]);
  });

  it('abre un grupo nuevo cuando pasan más de cinco minutos', () => {
    const rows = threadRows([input('a', 'done', at(-20 * 60_000)), input('b', 'done', at(-60_000))], undefined, NOW);
    expect(rows.filter((row) => row.kind === 'message').map((row) => row.startsGroup)).toEqual([true, true]);
  });

  it('pone la respuesta canónica consolidada justo después del mensaje que responde', () => {
    const root = input('m1', 'done');
    const rows = threadRows([root, input('m2', 'pending')], reply(root), NOW);
    expect(rows.map((row) => row.kind)).toEqual(['day', 'message', 'reply', 'message']);
    expect(threadRows([root], reply(root, { reply: '  ' }), NOW).some((row) => row.kind === 'reply')).toBe(false);
  });
});

describe('dayLabel', () => {
  it('dice hoy, ayer o la fecha', () => {
    expect(dayLabel(NOW - 60_000, NOW)).toBe('Hoy');
    expect(dayLabel(NOW - 24 * 3_600_000, NOW)).toBe('Ayer');
    expect(dayLabel(Date.parse('2026-09-01T12:00:00'), NOW)).toMatch(/1 de septiembre/);
    expect(dayLabel(Date.parse('2025-09-01T12:00:00'), NOW)).toMatch(/2025/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseOperatorCommand } from '../src/operator-commands/parse.js';
import type { TelegramEntity } from '../src/types.js';

function entity(type: string, offset: number, length: number): TelegramEntity {
  return { type, offset, length };
}

function parse(
  text: string,
  entities?: TelegramEntity[],
  botUsername?: string
) {
  return parseOperatorCommand({
    text,
    entities,
    ...(botUsername === undefined ? {} : { botUsername })
  });
}

describe('parseOperatorCommand', () => {
  it('ignores ordinary chat text', () => {
    expect(parse('seguí con el turno')).toEqual({ kind: 'none' });
  });

  it('ignores a slash that Telegram did not mark as bot_command', () => {
    expect(parse('/estado')).toEqual({ kind: 'none' });
    expect(parse('/estado', [entity('mention', 0, 7)])).toEqual({ kind: 'none' });
  });

  it('ignores a bot_command that is not at offset 0', () => {
    const text = 'mira /estado';
    expect(parse(text, [entity('bot_command', 5, 7)])).toEqual({ kind: 'none' });
  });

  it('parses /ayuda and /estado with an optional alias', () => {
    expect(parse('/ayuda', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'ayuda' }
    });
    expect(parse('/estado', [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'estado' }
    });
    expect(parse('/estado socrates', [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'estado', alias: 'socrates' }
    });
  });

  it('parses /trabados and /colas', () => {
    expect(parse('/trabados', [entity('bot_command', 0, 9)])).toEqual({
      kind: 'command', command: { name: 'trabados' }
    });
    expect(parse('/colas hegel', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'colas', alias: 'hegel' }
    });
  });

  it('parses replay and cancelar only with a UUID', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parse(`/replay ${id}`, [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'replay', deliveryId: id }
    });
    expect(parse(`/cancelar ${id} se colgó`, [entity('bot_command', 0, 9)])).toEqual({
      kind: 'command', command: { name: 'cancelar', deliveryId: id, reason: 'se colgó' }
    });
    expect(parse('/replay', [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'replay' }
    });
    expect(parse('/replay not-a-uuid', [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'replay' }
    });
  });

  it('parses /nudge with a single alias', () => {
    expect(parse('/nudge zeus', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'nudge', alias: 'zeus' }
    });
    expect(parse('/nudge', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'nudge' }
    });
  });

  it('parses /forzar_salida listing, inspect and confirmed replay', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(parse('/forzar_salida', [entity('bot_command', 0, 14)])).toEqual({
      kind: 'command', command: { name: 'forzar_salida', duplicateOk: false }
    });
    expect(parse(`/forzar_salida ${id}`, [entity('bot_command', 0, 14)])).toEqual({
      kind: 'command', command: { name: 'forzar_salida', letterId: id, duplicateOk: false }
    });
    expect(parse(`/forzar_salida ${id} duplicado-ok`, [entity('bot_command', 0, 14)])).toEqual({
      kind: 'command', command: { name: 'forzar_salida', letterId: id, duplicateOk: true }
    });
    expect(parse(`/forzar-salida ${id} duplicado-ok`, [entity('bot_command', 0, 14)])).toEqual({
      kind: 'command', command: { name: 'forzar_salida', letterId: id, duplicateOk: true }
    });
    expect(parse(`/forzar_salida ${id} duplicado-ok extra`, [entity('bot_command', 0, 14)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'forzar_salida' }
    });
  });

  it('treats an unknown name as a command so the handler can reply help instead of publishing', () => {
    expect(parse('/start', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'start' }
    });
  });

  it('accepts /cmd@self and ignores /cmd@other', () => {
    const self = '/estado@kant_cauce_bot';
    expect(parse(self, [entity('bot_command', 0, self.length)], 'kant_cauce_bot')).toEqual({
      kind: 'command', command: { name: 'estado' }
    });
    const other = '/estado@socrates_cauce_bot';
    expect(parse(other, [entity('bot_command', 0, other.length)], 'kant_cauce_bot')).toEqual({
      kind: 'none'
    });
  });

  it('rejects an invalid alias instead of inventing a command', () => {
    expect(parse('/estado SOCRATES', [entity('bot_command', 0, 7)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'estado' }
    });
    expect(parse('/nudge bad alias', [entity('bot_command', 0, 6)])).toEqual({
      kind: 'command', command: { name: 'unknown', raw: 'nudge' }
    });
  });
});

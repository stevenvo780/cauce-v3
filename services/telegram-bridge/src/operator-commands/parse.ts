import { ALIAS_PATTERN, RFC_UUID_PATTERN } from '@cauce/protocol';
import type { TelegramEntity } from '../types.js';

export type OperatorCommandName =
  | 'ayuda'
  | 'estado'
  | 'trabados'
  | 'colas'
  | 'replay'
  | 'cancelar'
  | 'nudge'
  | 'forzar_salida'
  | 'unknown';

export type OperatorCommand =
  | { readonly name: 'ayuda' }
  | { readonly name: 'estado'; readonly alias?: string }
  | { readonly name: 'trabados' }
  | { readonly name: 'colas'; readonly alias?: string }
  | { readonly name: 'replay'; readonly deliveryId: string }
  | { readonly name: 'cancelar'; readonly deliveryId: string; readonly reason?: string }
  | { readonly name: 'nudge'; readonly alias: string }
  | { readonly name: 'forzar_salida'; readonly letterId?: string; readonly duplicateOk: boolean }
  | { readonly name: 'unknown'; readonly raw: string };

export type OperatorParseResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'command'; readonly command: OperatorCommand };

export interface OperatorParseInput {
  readonly text?: string | undefined;
  readonly entities?: readonly TelegramEntity[] | undefined;
  readonly botUsername?: string | undefined;
}

const NONE: OperatorParseResult = { kind: 'none' };
const COMMAND_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const DUPLICATE_OK = 'duplicado-ok';

function unknown(raw: string): OperatorParseResult {
  return { kind: 'command', command: { name: 'unknown', raw } };
}

function canonicalName(value: string): string {
  return value.replace(/-/g, '_');
}

function firstCommand(text: string, entities: readonly TelegramEntity[] | undefined): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  for (const entity of entities as readonly TelegramEntity[]) {
    if (entity.type !== 'bot_command') continue;
    if (!Number.isSafeInteger(entity.offset) || entity.offset !== 0) return undefined;
    if (!Number.isSafeInteger(entity.length) || entity.length < 2) return undefined;
    if (entity.offset + entity.length > text.length) return undefined;
    return text.slice(entity.offset, entity.offset + entity.length);
  }
  return undefined;
}

function parseAlias(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return ALIAS_PATTERN.test(value) ? value : undefined;
}

function parseUuid(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return RFC_UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function build(name: string, args: readonly string[]): OperatorCommand | undefined {
  if (name === 'ayuda' && args.length === 0) return { name: 'ayuda' };
  if (name === 'trabados' && args.length === 0) return { name: 'trabados' };
  if (name === 'estado') {
    if (args.length === 0) return { name: 'estado' };
    const alias = parseAlias(args[0]);
    if (args.length === 1 && alias !== undefined) return { name: 'estado', alias };
    return undefined;
  }
  if (name === 'colas') {
    if (args.length === 0) return { name: 'colas' };
    const alias = parseAlias(args[0]);
    if (args.length === 1 && alias !== undefined) return { name: 'colas', alias };
    return undefined;
  }
  if (name === 'replay') {
    const deliveryId = parseUuid(args[0]);
    if (args.length === 1 && deliveryId !== undefined) return { name: 'replay', deliveryId };
    return undefined;
  }
  if (name === 'cancelar') {
    const deliveryId = parseUuid(args[0]);
    if (deliveryId === undefined || args.length < 1) return undefined;
    const reason = args.slice(1).join(' ').trim();
    return reason.length === 0
      ? { name: 'cancelar', deliveryId }
      : { name: 'cancelar', deliveryId, reason };
  }
  if (name === 'nudge') {
    const alias = parseAlias(args[0]);
    if (args.length === 1 && alias !== undefined) return { name: 'nudge', alias };
    return undefined;
  }
  if (name === 'forzar_salida') {
    if (args.length === 0) return { name: 'forzar_salida', duplicateOk: false };
    const letterId = parseUuid(args[0]);
    if (letterId === undefined) return undefined;
    if (args.length === 1) return { name: 'forzar_salida', letterId, duplicateOk: false };
    if (args.length === 2 && args[1] === DUPLICATE_OK) {
      return { name: 'forzar_salida', letterId, duplicateOk: true };
    }
    return undefined;
  }
  return undefined;
}

/**
 * A leading `bot_command` entity is the only thing that counts. Plain slash text without
 * that entity is ordinary chat and must keep going to the agent.
 */
export function parseOperatorCommand(input: OperatorParseInput): OperatorParseResult {
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return NONE;
  const raw = firstCommand(text, input.entities);
  if (!raw?.startsWith('/')) return NONE;
  const at = raw.indexOf('@');
  const token = at < 0 ? raw.slice(1) : raw.slice(1, at);
  if (at >= 0) {
    const suffix = raw.slice(at + 1).toLowerCase();
    const self = input.botUsername?.toLowerCase();
    if (self !== undefined && suffix !== self) return NONE;
  }
  const name = canonicalName(token.toLowerCase());
  if (!COMMAND_NAME.test(name)) return NONE;
  const rest = text.slice(raw.length).trim();
  const args = rest.length === 0 ? [] : rest.split(/\s+/u);
  const command = build(name, args);
  if (command === undefined) return unknown(name);
  return { kind: 'command', command };
}

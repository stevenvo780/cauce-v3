import type { TelegramAliasConfig, TelegramEntity } from '../types.js';
import { dispatchOperatorCommand, type OperatorActions } from './dispatch.js';
import { parseOperatorCommand } from './parse.js';

export interface OperatorCommandRequest {
  readonly config: Pick<TelegramAliasConfig,
    'alias' | 'tenant_id' | 'room_id' | 'operator_commands' | 'operator_user_ids' | 'bot_username'>;
  readonly botId: string;
  readonly userId: string;
  readonly privateChat: boolean;
  readonly text?: string | undefined;
  readonly entities?: readonly TelegramEntity[] | undefined;
  readonly updateId: number;
  readonly botUsername?: string | undefined;
  readonly actions: OperatorActions;
}

export type OperatorHandleResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'handled'; readonly reply: string; readonly command: string; readonly failed: boolean };

const IGNORED: OperatorHandleResult = { kind: 'ignored' };

export function operatorCommandsEnabled(
  config: Pick<TelegramAliasConfig, 'operator_commands' | 'operator_user_ids'>,
  userId: string
): boolean {
  return config.operator_commands === true
    && Array.isArray(config.operator_user_ids)
    && config.operator_user_ids.includes(userId);
}

/**
 * Private chat + opted-in alias + allowlisted operator + leading bot_command.
 * Anything else is ignored so the poller publishes exactly as today.
 */
export async function handleOperatorCommand(input: OperatorCommandRequest): Promise<OperatorHandleResult> {
  if (!input.privateChat) return IGNORED;
  if (!operatorCommandsEnabled(input.config, input.userId)) return IGNORED;
  const parsed = parseOperatorCommand({
    text: input.text,
    entities: input.entities,
    botUsername: input.botUsername ?? input.config.bot_username
  });
  if (parsed.kind === 'none') return IGNORED;
  const { text: reply, failed } = await dispatchOperatorCommand(parsed.command, {
    actorTenant: input.config.tenant_id,
    actorAlias: input.config.alias,
    roomId: input.config.room_id,
    botId: input.botId,
    updateId: input.updateId
  }, input.actions);
  return { kind: 'handled', reply, command: parsed.command.name, failed };
}

import type { BridgeRecipient, TelegramAliasConfig } from './types.js';

export function telegramAliasKey(identity: Pick<BridgeRecipient, 'tenant_id' | 'alias'>): string {
  return `${identity.tenant_id}/${identity.alias}`;
}

export function selectTelegramAliases(configs: readonly TelegramAliasConfig[], selector?: string): TelegramAliasConfig[] {
  if (!selector) return [...configs];
  const keys = new Set<string>();
  for (const name of selector.split(',').map(value => value.trim()).filter(Boolean)) {
    const matches = configs.filter(entry => name.includes('/') ? telegramAliasKey(entry) === name : entry.alias === name);
    if (matches.length !== 1) throw new Error('Telegram alias selector is unknown or ambiguous');
    for (const entry of matches) keys.add(telegramAliasKey(entry));
  }
  const result = configs.filter(entry => keys.has(telegramAliasKey(entry)));
  if (result.length === 0) throw new Error('Telegram alias selector is empty');
  return result;
}

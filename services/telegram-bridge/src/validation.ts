export { objectRecord } from '@cauce/protocol';

export function positiveTelegramId(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : undefined;
}

import { createHash } from 'node:crypto';

export function hashToUuidV7(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest('hex').slice(0, 32), 'hex');
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function hasUnsafeCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)
    ) {
      return true;
    }
  }
  return false;
}

export function positiveTelegramId(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : undefined;
}

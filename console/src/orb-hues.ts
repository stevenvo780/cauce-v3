function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  return value >>> 0;
}

/** Identity hues: stable per agent and deliberately not the state palette. */
export function orbHues(seed: string): [number, number, number] {
  const base = hash(seed) % 360;
  return [base, (base + 48) % 360, (base + 168) % 360];
}


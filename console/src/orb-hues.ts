function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  return value >>> 0;
}

/** The three identity hues spread from one base, so a chosen hue keeps the orb's harmony. */
export function orbHuesFrom(base: number): [number, number, number] {
  const start = ((Math.round(base) % 360) + 360) % 360;
  return [start, (start + 48) % 360, (start + 168) % 360];
}

/** Identity hues: stable per agent and deliberately not the state palette. A chosen hue overrides the seed. */
export function orbHues(seed: string, hue?: number | null): [number, number, number] {
  return orbHuesFrom(hue ?? hash(seed) % 360);
}

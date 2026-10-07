export function seedOf(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  return value >>> 0;
}

/** mulberry32: tiny, seedable, good enough to make each person stroll their own way. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

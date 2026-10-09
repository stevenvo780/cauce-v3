/**
 * Keeps each id's slot while it stays present and below `limit`; newcomers take the lowest free one.
 * Without a limit slots grow past the end instead of failing.
 */
export function assignSlots(previous: ReadonlyMap<string, number>, ids: readonly string[], limit?: number): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  const present = [...ids].sort();
  for (const id of present) {
    const slot = previous.get(id);
    if (slot !== undefined && !used.has(slot) && (limit === undefined || slot < limit)) {
      next.set(id, slot);
      used.add(slot);
    }
  }
  let free = 0;
  for (const id of present) {
    if (next.has(id)) continue;
    while (used.has(free)) free += 1;
    next.set(id, free);
    used.add(free);
  }
  return next;
}

export function sameSlots(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, slot] of a) if (b.get(id) !== slot) return false;
  return true;
}

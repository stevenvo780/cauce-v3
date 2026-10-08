const POD_SEATS = 4;
const MIN_CAPACITY = 8;
const SPARE = 2;
/** A map this much roomier than needed is rebuilt smaller; anything less is kept. */
const SLACK = 8;

/** Desks and beds to build for a fleet: whole pods, with spare seats so a new arrival fits without a rebuild. */
export function capacityFor(count: number): number {
  return Math.max(MIN_CAPACITY, Math.ceil((count + SPARE) / POD_SEATS) * POD_SEATS);
}

/** Grows only when the fleet no longer fits and shrinks only when the map is far too big. */
export function nextCapacity(count: number, previous?: number): number {
  const need = capacityFor(count);
  if (previous === undefined || count > previous) return need;
  return previous - need <= SLACK ? previous : need;
}

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

import { useState } from 'react';
import { assignSlots, nextCapacity, sameSlots } from './capacity';

/** Desk or bed capacity that survives ordinary adds and removes. */
export function useCapacity(count: number): number {
  const [kept, setKept] = useState(() => nextCapacity(count));
  const next = nextCapacity(count, kept);
  if (next !== kept) setKept(next);
  return next;
}

/** A persistent id -> slot map: nobody else moves when someone arrives or leaves. */
export function useSlots(ids: readonly string[], limit?: number): ReadonlyMap<string, number> {
  const [kept, setKept] = useState<ReadonlyMap<string, number>>(() => new Map());
  const next = assignSlots(kept, ids, limit);
  if (!sameSlots(next, kept)) setKept(next);
  return sameSlots(next, kept) ? kept : next;
}

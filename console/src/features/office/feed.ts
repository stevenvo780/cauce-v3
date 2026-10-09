import type { TubeEvent, TubeEventKind } from './tubes';

export interface FeedEntry {
  id: string;
  from: string;
  to: string;
  by: 'tube' | 'hand';
  status: TubeEventKind;
  /** Wall clock, ms, of the moment it was sent. */
  at: number;
}

const FEED_LIMIT = 24;

const RANK: Readonly<Record<TubeEventKind, number>> = { sent: 0, handed: 1, arrived: 1, collected: 2 };

export function mergeFeed(feed: readonly FeedEntry[], event: TubeEvent): FeedEntry[] {
  const existing = feed.find((entry) => entry.id === event.id);
  if (existing) {
    if (RANK[event.kind] <= RANK[existing.status]) return feed as FeedEntry[];
    return feed.map((entry) => (entry === existing ? { ...entry, status: event.kind } : entry));
  }
  return [{ id: event.id, from: event.from, to: event.to, by: event.by, status: event.kind, at: event.at }, ...feed].slice(0, FEED_LIMIT);
}

export interface FeedRow { entry: FeedEntry; count: number }

/** Neighbouring deliveries between the same two agents in the same state read as one row with a count. */
export function feedRows(feed: readonly FeedEntry[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const entry of feed) {
    const last = rows.at(-1);
    if (last?.entry.from === entry.from && last.entry.to === entry.to && last.entry.status === entry.status) last.count += 1;
    else rows.push({ entry, count: 1 });
  }
  return rows;
}

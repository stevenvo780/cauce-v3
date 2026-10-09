import { describe, expect, it } from 'vitest';
import { lotCell } from './campus-lots';
import { feedRows, mergeFeed, type FeedEntry } from './feed';
import { SEEN_LIMIT, remember } from './simulation';
import { createLine, launch, type TubeEvent } from './tubes';
import { buildWorldMap, groupLevelId } from './world-map';

const event = (id: string, kind: TubeEvent['kind'], from = 't/a', to = 't/b'): TubeEvent => ({ id, kind, from, to, at: 1_000, by: kind === 'handed' ? 'hand' : 'tube' });

describe('the tubes feed', () => {
  it('keeps one row per delivery that only moves forward: sent, arrived, collected', () => {
    let feed: FeedEntry[] = [];
    feed = mergeFeed(feed, event('d1', 'sent'));
    feed = mergeFeed(feed, event('d1', 'arrived'));
    feed = mergeFeed(feed, event('d1', 'sent'));
    expect(feed).toEqual([expect.objectContaining({ id: 'd1', status: 'arrived', by: 'tube' })]);
    feed = mergeFeed(feed, event('d2', 'handed'));
    feed = mergeFeed(feed, event('d1', 'collected'));
    expect(feed.map((entry) => [entry.id, entry.status])).toEqual([['d2', 'handed'], ['d1', 'collected']]);
    for (let index = 0; index < 40; index += 1) feed = mergeFeed(feed, event(`x${String(index)}`, 'sent'));
    expect(feed).toHaveLength(24);
  });

  it('folds neighbouring deliveries between the same pair into one row with a count', () => {
    let feed: FeedEntry[] = [];
    for (const id of ['a', 'b', 'c']) feed = mergeFeed(feed, event(id, 'sent'));
    feed = mergeFeed(feed, event('d', 'sent', 't/a', 't/c'));
    expect(feedRows(feed).map((row) => [row.entry.to, row.count])).toEqual([['t/c', 1], ['t/b', 3]]);
  });
});

describe('the tray and the delivery memory', () => {
  it('closes a capsule dropped from a full tray as collected, so the feed does not keep it waiting', () => {
    const map = buildWorldMap({ groups: [{ id: 'grp.a', label: 'a', hue: 30, seats: 4, cell: lotCell(0) }], beds: 4, pods: 2 });
    const line = createLine();
    const heard: TubeEvent[] = [];
    line.listener = (item) => { heard.push(item); };
    const level = groupLevelId('grp.a');
    for (let index = 0; index < 49; index += 1) launch(line, map, { id: `d${String(index)}`, from: 't/a', to: 't/b', fromLevel: level, toLevel: level }, 0, true, 1);
    expect(line.capsules).toHaveLength(48);
    expect(heard.filter((item) => item.kind === 'collected').map((item) => item.id)).toEqual(['d0']);
    let feed: FeedEntry[] = [];
    for (const item of heard) feed = mergeFeed(feed, item);
    expect(feed.find((entry) => entry.id === 'd0')?.status).toBe('collected');
  });

  it('remembers a bounded number of deliveries and only forgets the ones no longer listed', () => {
    const seen = new Set<string>();
    expect(remember(seen, 'kept')).toBe(true);
    expect(remember(seen, 'kept')).toBe(false);
    for (let index = 0; index < SEEN_LIMIT * 2; index += 1) {
      remember(seen, `old${String(index)}`);
      if (index % 100 === 0) remember(seen, 'kept');
    }
    expect(seen.size).toBe(SEEN_LIMIT);
    expect(seen.has('kept')).toBe(true);
    expect(seen.has('old0')).toBe(false);
    expect(remember(seen, 'kept')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { readingOrder, spatialNext } from './spatial';

const grid = [
  { id: 'z-top-left', x: 10, y: 10 }, { id: 'a-top-right', x: 50, y: 12 },
  { id: 'm-bottom-left', x: 10, y: 60 }, { id: 'b-bottom-right', x: 50, y: 58 },
  { id: 'c-far-right', x: 120, y: 80 },
];

describe('spatial keyboard navigation', () => {
  it('orders by rows, then left to right, whatever the ids say', () => {
    expect(readingOrder(grid).map((point) => point.id)).toEqual(['z-top-left', 'a-top-right', 'm-bottom-left', 'b-bottom-right', 'c-far-right']);
  });

  it('moves to the neighbour in the pressed direction and stays at an edge', () => {
    expect(spatialNext(grid, null, 'right')).toBe('z-top-left');
    expect(spatialNext(grid, 'z-top-left', 'right')).toBe('a-top-right');
    expect(spatialNext(grid, 'z-top-left', 'down')).toBe('m-bottom-left');
    expect(spatialNext(grid, 'b-bottom-right', 'left')).toBe('m-bottom-left');
    expect(spatialNext(grid, 'b-bottom-right', 'right')).toBe('c-far-right');
    expect(spatialNext(grid, 'z-top-left', 'up')).toBe('z-top-left');
  });
});

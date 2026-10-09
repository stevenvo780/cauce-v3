import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { lotCell } from './campus-lots';
import { CAMPUS } from './level';
import { useOfficeEngine } from './use-office-engine';
import { buildWorldMap, groupLevelId, type WorldMap } from './world-map';

const groupA = { id: 'grp.a', label: 'a', hue: 30, seats: 4, cell: lotCell(0) };
const groupB = { id: 'grp.b', label: 'b', hue: 220, seats: 4, cell: lotCell(1) };
const both = buildWorldMap({ groups: [groupA, groupB], beds: 4, pods: 2 });
const onlyA = buildWorldMap({ groups: [groupA], beds: 4, pods: 2 });
const B = groupLevelId('grp.b');
const props = { selected: null, hovered: null, highlight: null, names: new Map<string, string>(), stats: new Map(), talkId: null };

const mount = (map: WorldMap) => renderHook(() => useOfficeEngine({ canvasRef: { current: null }, map, inputs: [], reducedMotion: true, night: false, props }));

it('comes back to the building it left, or to the campus when that building is gone', () => {
  const first = mount(both);
  act(() => { first.result.current.engine.go(B); });
  expect(first.result.current.level).toBe(B);
  first.unmount();

  const without = mount(onlyA);
  expect(without.result.current.level).toBe(CAMPUS);
  expect(without.result.current.engine.level).toBe(CAMPUS);
  without.unmount();

  const again = mount(both);
  expect(again.result.current.level).toBe(B);
  expect(again.result.current.engine.level).toBe(B);
  again.unmount();
});

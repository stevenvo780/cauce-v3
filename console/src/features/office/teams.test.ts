import { describe, expect, it } from 'vitest';
import type { TopologySnapshot } from '../../api/types';
import { NO_TEAM, groupDirectory, membershipOf, resolveHues, teamHue } from './teams';
import { officeRoomKey } from './office-layout';

const topology: TopologySnapshot = {
  tenants: [
    { id: 'Steven', rooms: [{ id: 'ops.infra', label: 'Infra' }, { id: 'grp.steven', label: 'Steven' }] },
    { id: 'Miguel', rooms: [{ id: 'ops.miguel' }, { id: 'grp.miguel', label: 'Miguel' }, { id: 'grp.extra', label: 'Extra' }] },
  ],
};
const directory = groupDirectory(topology);

const agent = (roomIds: string[], off: string[] = []) => ({
  tenantId: 'Miguel', alias: 'kratos', roomIds,
  roomMembership: Object.fromEntries(roomIds.map((id) => [id, !off.includes(id)])),
});

describe('team derivation', () => {
  it('prefers a grp.* room over an operational one that comes first', () => {
    const membership = membershipOf(agent(['ops.miguel', 'grp.miguel']), directory);
    const { team, groups } = membership;
    expect(team).toMatchObject({ id: officeRoomKey('Miguel', 'grp.miguel'), label: 'Miguel' });
    expect(groups).toEqual([officeRoomKey('Miguel', 'ops.miguel')]);
    expect(membership.groupLabels).toEqual(['ops.miguel']);
  });

  it('takes the first enabled membership in topology order, not in the agent order', () => {
    const { team, groups } = membershipOf(agent(['grp.extra', 'grp.miguel']), directory);
    expect(team.id).toBe(officeRoomKey('Miguel', 'grp.miguel'));
    expect(groups).toEqual([officeRoomKey('Miguel', 'grp.extra')]);
  });

  it('skips disabled memberships and falls back to an operational room', () => {
    expect(membershipOf(agent(['grp.miguel', 'ops.miguel'], ['grp.miguel']), directory).team.id).toBe(officeRoomKey('Miguel', 'ops.miguel'));
  });

  it('puts agents without an enabled group in «Sin grupo»', () => {
    expect(membershipOf(agent([]), directory)).toEqual({ team: NO_TEAM, groups: [], groupLabels: [] });
    expect(membershipOf(agent(['grp.miguel'], ['grp.miguel']), directory).team).toEqual(NO_TEAM);
  });
  it('keeps same room names in different tenants as separate buildings', () => {
    const homonymous = groupDirectory({ tenants: [{ id: 'One', rooms: [{ id: 'general', label: 'One room' }] },
      { id: 'Two', rooms: [{ id: 'general', label: 'Two room' }] }] });
    expect(homonymous.order.size).toBe(2);
    expect(membershipOf({ tenantId: 'Two', alias: 'worker', roomIds: ['general'], roomMembership: {} }, homonymous).team)
      .toMatchObject({ id: officeRoomKey('Two', 'general'), label: 'Two room' });
  });
});

describe('team colours', () => {
  it('derives a stable hue from the group id', () => {
    expect(teamHue('grp.miguel')).toBe(teamHue('grp.miguel'));
    expect(teamHue('grp.miguel')).not.toBe(teamHue('grp.isa'));
    expect(teamHue(NO_TEAM.id)).toBeLessThan(0);
  });

  it('keeps neighbouring groups apart and the result independent of input order', () => {
    const ids = ['grp.isa', 'grp.jhon', 'grp.miguel', 'grp.pablo', 'grp.steven'];
    const hues = resolveHues(ids);
    const values = ids.map((id) => hues.get(id) ?? -1);
    for (let i = 0; i < values.length; i += 1) for (let j = i + 1; j < values.length; j += 1) {
      const gap = Math.abs(values[i] - values[j]);
      expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(40);
    }
    expect([...resolveHues([...ids].reverse())]).toEqual([...hues]);
  });
});

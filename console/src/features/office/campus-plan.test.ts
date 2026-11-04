import { describe, expect, it } from 'vitest';
import { createPlanMemory, planCampus, type PlanGroup } from './campus-plan';

const team = { id: 'Hospital/grp.hospital', label: 'Equipo', hue: 10 };
const directory: PlanGroup[] = [team, { id: 'hub/office', label: 'office', hue: 200 }];

describe('planCampus', () => {
  it('raises no building for a group nobody works in', () => {
    const plan = planCampus(createPlanMemory(), [{ id: 'Hospital/operador', state: 'down', team }], directory, 0);
    expect(plan.groups.map((group) => group.id)).toEqual(['Hospital/grp.hospital']);
  });

  it('keeps the house of a group whose only agent is down', () => {
    const plan = planCampus(createPlanMemory(), [{ id: 'Hospital/perseo', state: 'down', team }], directory, 0);
    expect(plan.homeOf.get('Hospital/perseo')).toBeDefined();
    expect(plan.groups).toHaveLength(1);
  });
});

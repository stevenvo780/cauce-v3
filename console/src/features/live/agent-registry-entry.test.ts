import { describe, expect, it } from 'vitest';
import type { ConfigurationSnapshot } from '../../api/types';
import { selectAgentRegistryEntry } from './agent-registry-entry';

function snapshot(agents: ConfigurationSnapshot['agents']): ConfigurationSnapshot {
  return { revision: 1, observed_at: '2026-09-01T00:00:00Z', agents };
}

describe('selectAgentRegistryEntry', () => {
  it('keeps an unavailable registry distinct from a missing agent', () => {
    expect(selectAgentRegistryEntry(snapshot(undefined), 'Steven', 'kant'))
      .toEqual({ state: 'registry-unavailable' });
    expect(selectAgentRegistryEntry(snapshot([]), 'Steven', 'kant'))
      .toEqual({ state: 'agent-missing' });
  });

  it('keeps an explicitly empty role as a published row', () => {
    expect(selectAgentRegistryEntry(snapshot([
      { tenant_id: 'Steven', alias: 'kant', role_brief: null },
    ]), 'Steven', 'kant')).toEqual({
      state: 'found',
      row: { tenant_id: 'Steven', alias: 'kant', role_brief: null },
      roleBrief: '',
    });
  });

  it('selects by tenant and alias without conflating equal aliases', () => {
    const result = selectAgentRegistryEntry(snapshot([
      { tenant_id: 'Miguel', alias: 'kant', role_brief: 'otro tenant' },
      { tenant_id: 'Steven', alias: 'kant', role_brief: 'coordinador' },
    ]), 'Steven', 'kant');

    expect(result.state).toBe('found');
    if (result.state === 'found') expect(result.roleBrief).toBe('coordinador');
  });
});

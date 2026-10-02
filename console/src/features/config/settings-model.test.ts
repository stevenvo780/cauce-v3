import { describe, expect, it } from 'vitest';
import { filterSettingsAgents, settingsAgents } from './settings-model';

describe('inventario compacto de configuración', () => {
  it('une registro y membresías sin confundir el mismo alias entre tenants', () => {
    const agents = settingsAgents({
      agents: [{ tenant_id: 'A', alias: 'same', harness_id: 'codex', enabled: true }],
      memberships: [
        { tenant_id: 'A', alias: 'same', room_id: 'one', enabled: true },
        { tenant_id: 'A', alias: 'same', room_id: 'two', enabled: false },
        { tenant_id: 'B', alias: 'same', room_id: 'one', enabled: true },
      ],
      rooms: [{ tenant_id: 'A', id: 'one', display_name: 'Equipo A' }, { tenant_id: 'B', id: 'one', display_name: 'Equipo B' }],
    });
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ tenantId: 'A', alias: 'same', registered: true, harness: 'codex' });
    expect(agents[0].groups).toEqual([
      { id: 'one', label: 'Equipo A', enabled: true }, { id: 'two', label: 'two', enabled: false },
    ]);
    expect(agents[1]).toMatchObject({ tenantId: 'B', registered: false, harness: undefined, enabled: undefined });
    expect(agents[1].groups[0].label).toBe('Equipo B');
    expect(agents[0].key).not.toBe(agents[1].key);
  });

  it('no presenta la proyección heredada como responsabilidad canónica ni inventa grupos', () => {
    const [agent] = settingsAgents({ agents: [{ tenant_id: 'A', alias: 'one', role_brief: 'obsoleto' }] });
    expect(agent.responsibility).toBeUndefined();
    expect(agent.groupsKnown).toBe(false);
    expect(agent.groups).toEqual([]);
    expect(agent.enabled).toBeUndefined();
    const [known] = settingsAgents({ agents: [{ tenant_id: 'A', alias: 'one' }], memberships: [] });
    expect(known.groupsKnown).toBe(true);
  });

  it('muestra responsabilidad canónica y busca también grupo, tenant y arnés', () => {
    const agents = settingsAgents({
      agents: [{ tenant_id: 'A', alias: 'one', display_name: 'Uno', harness_id: 'codex' }],
      agent_profiles: [{ tenant_id: 'A', alias: 'one', role_summary: 'Revisar cambios' }],
      memberships: [{ tenant_id: 'A', alias: 'one', room_id: 'ops' }],
    });
    expect(agents[0].responsibility).toBe('Revisar cambios');
    for (const term of [' uno ', 'codex', 'ops', 'revisar', 'A']) expect(filterSettingsAgents(agents, term)).toEqual(agents);
    expect(filterSettingsAgents(agents, 'nadie')).toEqual([]);
  });

  it('no inventa identidades para filas incompletas y conserva un inventario vacío', () => {
    expect(settingsAgents({ agents: [{ alias: 'one' }, { tenant_id: 'A' }], memberships: [] })).toEqual([]);
    expect(settingsAgents({})).toEqual([]);
  });
});

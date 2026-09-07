import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot, TopologySnapshot } from '../../api/types';
import { buildLiveViews, humanOrigins } from './agent-state';
import { projectLiveFleet } from './live-projection';

function agent(alias: string, fields: Partial<FleetActivityAgent> = {}): FleetActivityAgent {
  return { tenant_id: 'Hospital', alias, registered: true, agent_enabled: true, work_state: 'idle',
    presence: { online: true }, in_flight: 0, queued: 0, ...fields };
}

describe('proyección de la flota viva', () => {
  it('retira bajas inactivas de agentes, cifras y membresías sin alterar el historial original', () => {
    const snapshot: FleetActivitySnapshot = {
      agents: [agent('operador'), agent('teseo'), agent('perseo'),
        agent('backend', { agent_enabled: false, flags: ['never_connected'] }),
        agent('frontend', { agent_enabled: false, flags: ['never_connected'] }),
        agent('console-proxy', { registered: false })],
      totals: { agents: 6, by_state: { idle: 6 }, flagged: { never_connected: 2 }, in_flight: 0 },
    };
    const topology: TopologySnapshot = { tenants: [{ id: 'Hospital', rooms: [{ id: 'grp.hospital', members:
      snapshot.agents?.map((a) => ({ alias: a.alias, enabled: true, registered: a.registered, agent_enabled: a.agent_enabled })) }] }] };
    const original = structuredClone({ snapshot, topology });
    const result = projectLiveFleet(snapshot, topology);
    expect(result.snapshot?.agents?.map((a) => a.alias)).toEqual(['operador', 'teseo', 'perseo']);
    expect(result.snapshot?.totals).toEqual({ agents: 3, by_state: { idle: 3 }, flagged: { never_connected: 0 }, in_flight: 0 });
    expect(result.topology?.tenants?.[0].rooms?.[0].members?.map((m) => m.alias)).toEqual(['operador', 'teseo', 'perseo']);
    expect({ snapshot, topology }).toEqual(original);
  });

  it.each<Partial<FleetActivityAgent>>([
    { in_flight: 1 }, { started: 1 }, { claimed_not_started: 1 }, { queued: 1 }, { queued_ready: 1 },
    { retrying: 1 }, { overdue_in_flight: 1 }, { in_flight_items: [{ delivery_id: 'pending' }] },
    { work_state: 'working' }, { work_state: 'queued' }, { work_state: 'stalled' }, { work_state: 'saturated' },
    { flags: ['overdue_acks'] }, { flags: ['queued_without_consumer'] },
  ])('conserva una baja explícita con evidencia pendiente %j', (fields) => {
    const pending = agent('retirado', { registered: false, agent_enabled: false, ...fields });
    expect(projectLiveFleet({ agents: [pending] }, undefined).snapshot?.agents).toEqual([pending]);
  });

  it('conserva participantes de una delegación en vuelo aunque sus contadores individuales sean cero', () => {
    const source = agent('backend', { agent_enabled: false });
    const target = agent('teseo', { in_flight: 1, in_flight_items: [{ from_tenant: 'Hospital', from_alias: 'backend', origin_adapter: 'telegram' }] });
    const snapshot = { agents: [source, target] };
    const projected = projectLiveFleet(snapshot, undefined).snapshot;
    expect(projected?.agents).toHaveLength(2);
    expect(humanOrigins(snapshot)).toEqual([]);
    expect(buildLiveViews(snapshot, {}, Date.now()).views.find((v) => v.alias === 'teseo')?.origenes)
      .toEqual([{ tipo: 'agente', tenant: 'Hospital', alias: 'backend' }]);
    const edgesOnly = { agents: [source], edges: [{ from_tenant: 'Hospital', from_alias: 'backend', to_tenant: 'Hospital', to_alias: 'teseo', in_flight: 1 }] };
    expect(projectLiveFleet(edgesOnly, undefined).snapshot?.agents).toEqual([source]);
  });

  it('los campos desconocidos siguen siendo desconocidos', () => {
    const unknown = agent('desconocido', { registered: null, agent_enabled: null });
    const projected = projectLiveFleet({ agents: [unknown, agent('baja', { agent_enabled: false })] }, undefined);
    expect(projected.snapshot?.agents).toEqual([unknown]);
    expect(projected.snapshot?.totals).toBeUndefined();
    const topology: TopologySnapshot = { tenants: [{ id: 'Hospital' }] };
    expect(projectLiveFleet(undefined, topology)).toEqual({ snapshot: undefined, topology });
  });

  it('excluye de la topología un principal no registrado sin inventar bajas para metadatos ausentes', () => {
    const topology: TopologySnapshot = { tenants: [{ id: 'Hospital', rooms: [{ id: 'grp.hospital', members: [
      { alias: 'console-proxy', registered: false, enabled: true }, { alias: 'sin-metadatos', enabled: true },
    ] }] }] };
    const result = projectLiveFleet({ agents: [agent('operador')] }, topology);
    expect(result.topology?.tenants?.[0].rooms?.[0].members?.map((m) => m.alias)).toEqual(['sin-metadatos']);
  });
});

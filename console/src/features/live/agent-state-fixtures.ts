import { http, HttpResponse } from 'msw';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import { server } from '../../mocks/server';

export function agent(overrides: Partial<FleetActivityAgent> = {}): FleetActivityAgent {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    registered: true,
    agent_enabled: true,
    presence: { online: true, lease_until: '2026-08-06T03:00:00.000Z' },
    work_state: 'idle',
    flags: [],
    in_flight: 0,
    started: 0,
    claimed_not_started: 0,
    queued: 0,
    in_flight_items: [],
    ...overrides,
  };
}

export function snapshot(agents: FleetActivityAgent[]): FleetActivitySnapshot {
  return {
    observed_at: '2026-08-06T02:54:49.452Z',
    thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
    agents,
  };
}

export function configConBrief(roleBrief: string, alias = 'kant') {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1,
    observed_at: new Date().toISOString(),
    agents: [
      { tenant_id: 'Steven', alias, harness_id: 'claude-code', enabled: true, role_brief: roleBrief },
    ],
    tenants: [], rooms: [], memberships: [], acl_edges: [], harness_definitions: [],
    role_policies: [], chain_policies: [], egress_destinations: [], provider_accounts: [],
    alias_routing_ceiling: [], agent_account_bindings: [], revisions: [],
  })));
}

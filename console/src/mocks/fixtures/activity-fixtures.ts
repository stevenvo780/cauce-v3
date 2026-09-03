import type {
  FleetActivityItem,
  FleetActivitySnapshot,
  FleetDelegationEdge,
} from '../../api/types';
import { topology } from './topology-config';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const secondsAgo = (seconds: number) => iso(-seconds * 1_000);

function enVuelo(id: string, desde: string, segundos: number, extra: Partial<FleetActivityItem> = {}): FleetActivityItem {
  const corte = desde.indexOf('/');
  return {
    delivery_id: id,
    message_id: `msg-${id}`,
    trace_id: `trace-${id}`,
    from_tenant: desde.slice(0, corte),
    from_alias: desde.slice(corte + 1),
    lane: 'interactive',
    origin_adapter: 'bus',
    published_at: secondsAgo(segundos + 2),
    status: 'started',
    attempt: 1,
    claimed_at: secondsAgo(segundos),
    ack_deadline_at: iso((600 - segundos) * 1_000),
    seconds_in_flight: segundos,
    last_ack_at: secondsAgo(Math.min(segundos, 25)),
    last_ack_status: 'started',
    ...extra,
  };
}

const CERRADAS_24H: Record<string, number> = {
  'Steven/zeus': 27, 'Steven/kant': 41, 'Steven/socrates': 12, 'Steven/argos': 19, 'Steven/jarvis': 33,
  'Miguel/janus': 16, 'Miguel/kratos': 22, 'Miguel/iza': 0, 'Miguel/atlas': 0,
  'Pablo/dedalo': 9, 'Pablo/seneca': 6, 'Pablo/vulcano': 0,
  'Isa/salva': 3, 'Jhon/hegel': 1,
};

function salasDe(tenantId: string, alias: string): string[] {
  const tenant = topology.tenants?.find((candidate) => candidate.id === tenantId);
  return (tenant?.rooms ?? [])
    .filter((room) => (room.members ?? []).some((member) => member.alias === alias))
    .map((room) => room.id ?? 'UNKNOWN');
}

function aristasDe(agents: FleetActivitySnapshot['agents']): FleetDelegationEdge[] {
  const conocidos = new Set((agents ?? []).map((agent) => `${agent.tenant_id}/${agent.alias}`));
  const acumulado = new Map<string, FleetDelegationEdge>();
  for (const agent of agents ?? []) {
    const destino = `${agent.tenant_id}/${agent.alias}`;
    for (const item of agent.in_flight_items ?? []) {
      if (!item.from_tenant || !item.from_alias) continue;
      const origen = `${item.from_tenant}/${item.from_alias}`;
      if (origen === destino || !conocidos.has(origen)) continue;
      const clave = `${origen}->${destino}`;
      const actual = acumulado.get(clave) ?? {
        from_tenant: item.from_tenant, from_alias: item.from_alias,
        to_tenant: agent.tenant_id, to_alias: agent.alias,
        in_flight: 0, total_window: 0, last_at: iso(0),
      };
      actual.in_flight = (actual.in_flight ?? 0) + 1;
      actual.total_window = (actual.total_window ?? 0) + 3;
      acumulado.set(clave, actual);
    }
  }
  return [...acumulado.values()];
}

function enriquecer(snapshot: FleetActivitySnapshot): FleetActivitySnapshot {
  const agents = (snapshot.agents ?? []).map((agent) => {
    const key = `${agent.tenant_id}/${agent.alias}`;
    const cerradas = CERRADAS_24H[key];
    return {
      ...agent,
      rooms: salasDe(agent.tenant_id, agent.alias),
      ...(typeof cerradas === 'number' ? { closed_24h: cerradas, failed_24h: 0 } : {}),
    };
  });
  return { ...snapshot, agents, edges: aristasDe(agents) };
}

export function mockActivity(): FleetActivitySnapshot {
  return enriquecer({
    observed_at: iso(0),
    thresholds: {
      saturation_in_flight: 8,
      stall_after_seconds: 300,
      ack_recent_seconds: 300,
      ack_lookback_seconds: 3600,
      items_per_agent: 10,
    },
    totals: {
      agents: 15,
      by_state: { idle: 3, queued: 1, working: 8, saturated: 1, stalled: 2 },
      flagged: {
        saturated: 2, ack_stalled: 2, overdue_acks: 1, lease_expired: 2,
        never_connected: 1, unregistered: 1, queued_without_consumer: 1,
      },
      in_flight: 63,
      queued: 29,
      retrying: 3,
      overdue_in_flight: 41,
    },
    agents: [
      {
        tenant_id: 'Steven', alias: 'zeus', display_name: 'Zeus', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'zeus-3d81c7f0', epoch: 204, last_heartbeat_at: secondsAgo(4), lease_until: iso(26_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 2, queued_ready: 2, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(45), oldest_in_flight_seconds: 45,
        nearest_ack_deadline_at: iso(555_000), max_attempt: 1,
        last_ack_at: secondsAgo(8), seconds_since_last_ack: 8, acks_recent: 21,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0001-4000-8000-a1b2c3d4e5f6', 'Steven/socrates', 45)],
      },
      {
        tenant_id: 'Steven', alias: 'socrates', display_name: 'Sócrates', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'socrates-29ce4b11', epoch: 37, last_heartbeat_at: secondsAgo(9), lease_until: iso(21_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(210), oldest_in_flight_seconds: 210,
        nearest_ack_deadline_at: iso(390_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 4,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', 'Miguel/janus', 210)],
      },
      {
        tenant_id: 'Steven', alias: 'argos', display_name: 'Argos', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'argos-4e22a9c3', epoch: 88, last_heartbeat_at: secondsAgo(7), lease_until: iso(23_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 1, queued_ready: 1, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(70), oldest_in_flight_seconds: 70,
        nearest_ack_deadline_at: iso(530_000), max_attempt: 1,
        last_ack_at: secondsAgo(15), seconds_since_last_ack: 15, acks_recent: 6,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0003-4000-8000-a1b2c3d4e5f6', 'Steven/kant', 70)],
      },
      {
        tenant_id: 'Miguel', alias: 'janus', display_name: 'Janus', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'janus-29ad5f02', epoch: 51, last_heartbeat_at: secondsAgo(11), lease_until: iso(19_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(330), oldest_in_flight_seconds: 330,
        nearest_ack_deadline_at: iso(270_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 3,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0004-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 330)],
      },
      {
        tenant_id: 'Miguel', alias: 'kratos', display_name: 'Kratos', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'kratos-0b31d7e4', epoch: 76, last_heartbeat_at: secondsAgo(5), lease_until: iso(25_000) },
        work_state: 'working', flags: [],
        in_flight: 2, started: 2, claimed_not_started: 0, queued: 3, queued_ready: 3, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(410), oldest_in_flight_seconds: 410,
        nearest_ack_deadline_at: iso(190_000), max_attempt: 1,
        last_ack_at: secondsAgo(18), seconds_since_last_ack: 18, acks_recent: 7,
        in_flight_items_truncated: false,
        in_flight_items: [
          enVuelo('1c0ffee0-0005-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 410, { lane: 'batch' }),
          enVuelo('1c0ffee0-0006-4000-8000-a1b2c3d4e5f6', 'Miguel/janus', 85),
        ],
      },
      {
        tenant_id: 'Miguel', alias: 'iza', display_name: 'Iza', harness_id: 'hermes',
        registered: true, agent_enabled: false,
        presence: { online: false, instance_id: 'iza-77b2e410', epoch: 12, last_heartbeat_at: secondsAgo(2_100), lease_until: secondsAgo(2_070) },
        work_state: 'idle', flags: ['lease_expired'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: secondsAgo(2_400), seconds_since_last_ack: 2_400, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Pablo', alias: 'dedalo', display_name: 'Dédalo', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'dedalo-9d2c1a75', epoch: 64, last_heartbeat_at: secondsAgo(12), lease_until: iso(18_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(150), oldest_in_flight_seconds: 150,
        nearest_ack_deadline_at: iso(450_000), max_attempt: 1,
        last_ack_at: secondsAgo(22), seconds_since_last_ack: 22, acks_recent: 5,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0007-4000-8000-a1b2c3d4e5f6', 'Steven/zeus', 150)],
      },
      {
        tenant_id: 'Pablo', alias: 'seneca', display_name: 'Séneca', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'seneca-5a90c3f8', epoch: 29, last_heartbeat_at: secondsAgo(14), lease_until: iso(16_000) },
        work_state: 'working', flags: [],
        in_flight: 1, started: 1, claimed_not_started: 0, queued: 2, queued_ready: 2, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(520), oldest_in_flight_seconds: 520,
        nearest_ack_deadline_at: iso(80_000), max_attempt: 1,
        last_ack_at: secondsAgo(25), seconds_since_last_ack: 25, acks_recent: 2,
        in_flight_items_truncated: false,
        in_flight_items: [enVuelo('1c0ffee0-0008-4000-8000-a1b2c3d4e5f6', 'Pablo/midas', 520, { lane: 'batch' })],
      },
      {
        tenant_id: 'Steven', alias: 'kant', display_name: 'Kant', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'kant-7f21c0d4', epoch: 118, last_heartbeat_at: secondsAgo(6), lease_until: iso(24_000) },
        work_state: 'working', flags: [],
        in_flight: 3, started: 3, claimed_not_started: 0, queued: 1, queued_ready: 1, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(259), oldest_in_flight_seconds: 259,
        nearest_ack_deadline_at: iso(41_000), max_attempt: 1,
        last_ack_at: secondsAgo(12), seconds_since_last_ack: 12, acks_recent: 9,
        in_flight_items_truncated: false,
        in_flight_items: [
          { delivery_id: '3f1a9b6e-2c47-4a0e-9d33-0b5c8e71a204', message_id: '8c5d2f10-7b3a-4e91-8f2c-6a41d09be557', trace_id: 'trace-2b7e4c19', from_tenant: 'Steven', from_alias: 'zeus', lane: 'interactive', origin_adapter: 'bus', published_at: secondsAgo(261), status: 'started', attempt: 1, claimed_at: secondsAgo(259), ack_deadline_at: iso(41_000), seconds_in_flight: 259, last_ack_at: secondsAgo(12), last_ack_status: 'started' },
          { delivery_id: 'aa02e7c5-91d6-4f38-b7e0-4c9a1d3f6b82', message_id: '1d94f7a2-3e58-4bb1-90c7-2f6e58a0dc39', trace_id: 'trace-9a1c33d7', from_tenant: 'Steven', from_alias: 'argos', lane: 'batch', origin_adapter: 'telegram', published_at: secondsAgo(180), status: 'started', attempt: 1, claimed_at: secondsAgo(178), ack_deadline_at: iso(120_000), seconds_in_flight: 178, last_ack_at: secondsAgo(30), last_ack_status: 'started' },
          { delivery_id: '6b18d0f9-4a72-4ee3-8c15-9d20e7f3ab41', message_id: 'b7e30c48-16d2-4a97-bf05-8e1c4d9027aa', trace_id: 'trace-5f22e19b', from_tenant: 'Steven', from_alias: 'zeus', lane: 'interactive', origin_adapter: 'bus', published_at: secondsAgo(96), status: 'leased', attempt: 1, claimed_at: secondsAgo(94), ack_deadline_at: iso(206_000), seconds_in_flight: 94, last_ack_at: null, last_ack_status: null },
        ],
      },
      {
        tenant_id: 'Steven', alias: 'jarvis', display_name: 'Jarvis', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'jarvis-b711e2a0', epoch: 42, last_heartbeat_at: secondsAgo(3), lease_until: iso(27_000) },
        work_state: 'saturated', flags: ['saturated'],
        in_flight: 9, started: 9, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(340), oldest_in_flight_seconds: 340,
        nearest_ack_deadline_at: iso(15_000), max_attempt: 1,
        last_ack_at: secondsAgo(20), seconds_since_last_ack: 20, acks_recent: 12,
        in_flight_items_truncated: false,
        in_flight_items: ['kant', 'kant', 'zeus', 'kant', 'argos', 'zeus', 'socrates', 'argos', 'socrates']
          .map((emisor, index) => enVuelo(
            `9c9f9c9f-0000-4000-8000-00000000000${String(index)}`,
            `Steven/${emisor}`,
            338 - index * 10,
            { lane: 'batch', ack_deadline_at: iso((15 + index * 10) * 1_000), last_ack_at: secondsAgo(20) },
          )),
      },
      {
        tenant_id: 'Pablo', alias: 'midas', display_name: null, harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: false, instance_id: 'midas-0a44be91', epoch: 41, last_heartbeat_at: secondsAgo(1_400), lease_until: secondsAgo(1_370) },
        work_state: 'stalled', flags: ['ack_stalled', 'saturated', 'overdue_acks', 'lease_expired'],
        in_flight: 41, started: 39, claimed_not_started: 2, queued: 12, queued_ready: 12, retrying: 3, overdue_in_flight: 41,
        oldest_claimed_at: secondsAgo(4_820), oldest_in_flight_seconds: 4_820,
        nearest_ack_deadline_at: secondsAgo(4_520), max_attempt: 2,
        last_ack_at: secondsAgo(1_268), seconds_since_last_ack: 1_268, acks_recent: 0,
        in_flight_items_truncated: true,
        in_flight_items: [
          { delivery_id: 'c9d47a02-5e18-4b63-97f1-3a0e8c25db76', message_id: '42a1e6b8-0c7d-4f52-b839-5e60a71cf204', trace_id: 'trace-77c1e05a', from_tenant: 'Pablo', from_alias: 'dedalo', lane: 'batch', origin_adapter: 'bus', published_at: secondsAgo(4_822), status: 'started', attempt: 1, claimed_at: secondsAgo(4_820), ack_deadline_at: secondsAgo(4_520), seconds_in_flight: 4_820, last_ack_at: secondsAgo(4_760), last_ack_status: 'started' },
          { delivery_id: '0e73b4f1-8a25-4d09-b6c3-71f0d5928ae4', message_id: '5c80917d-4e2b-41a6-9f38-b207ce4d1650', trace_id: 'trace-77c1e05a', from_tenant: 'Pablo', from_alias: 'dedalo', lane: 'batch', origin_adapter: 'bus', published_at: secondsAgo(4_710), status: 'leased', attempt: 2, claimed_at: secondsAgo(4_708), ack_deadline_at: secondsAgo(4_408), seconds_in_flight: 4_708, last_ack_at: null, last_ack_status: null },
        ],
      },
      {
        tenant_id: 'Miguel', alias: 'atlas', display_name: null, harness_id: null,
        registered: false, agent_enabled: null,
        presence: { online: false, instance_id: 'atlas-31c7f9a2', epoch: 9, last_heartbeat_at: secondsAgo(11_600), lease_until: secondsAgo(11_570) },
        work_state: 'queued', flags: ['lease_expired', 'queued_without_consumer', 'unregistered'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 8, queued_ready: 8, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Isa', alias: 'salva', display_name: 'Salva', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'salva-be104d77', epoch: 63, last_heartbeat_at: secondsAgo(2), lease_until: iso(28_000) },
        work_state: 'idle', flags: [],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: secondsAgo(799), seconds_since_last_ack: 799, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Pablo', alias: 'vulcano', display_name: 'Vulcano', harness_id: 'openclaw',
        registered: true, agent_enabled: false,
        presence: undefined,
        work_state: 'idle', flags: ['never_connected'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false, in_flight_items: [],
      },
      {
        tenant_id: 'Jhon', alias: 'hegel', display_name: 'Hegel', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, instance_id: 'hegel-122f9a10', epoch: 9, last_heartbeat_at: secondsAgo(5), lease_until: iso(25_000) },
        work_state: 'stalled', flags: ['ack_stalled'],
        in_flight: 2, started: 1, claimed_not_started: 1, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
        oldest_claimed_at: secondsAgo(610), oldest_in_flight_seconds: 610,
        nearest_ack_deadline_at: secondsAgo(310), max_attempt: 1,
        last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
        in_flight_items_truncated: false,
        in_flight_items: [
          enVuelo('e1a2b3c4-d5e6-4f70-8091-a2b3c4d5e6f7', 'Steven/argos', 610, {
            ack_deadline_at: secondsAgo(310), last_ack_at: null, last_ack_status: null,
          }),
          enVuelo('7d0c9b8a-1e2f-4a3b-9c4d-5e6f7a8b9c0d', 'Jhon/hegel', 240, {
            origin_adapter: 'telegram', status: 'leased', last_ack_at: null, last_ack_status: null,
          }),
        ],
      },
    ],
  });
}

export function mockActivityEnReposo(): FleetActivitySnapshot {
  const base = mockActivity();
  const agents = (base.agents ?? []).map((agent) => ({
    ...agent,
    registered: true,
    agent_enabled: true,
    work_state: 'idle' as const,
    flags: [],
    in_flight: 0, started: 0, claimed_not_started: 0,
    queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
    oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null,
    in_flight_items: [], in_flight_items_truncated: false,
    presence: { online: true, instance_id: agent.presence?.instance_id ?? null, epoch: agent.presence?.epoch ?? null, last_heartbeat_at: secondsAgo(4), lease_until: iso(25_000) },
    last_ack_at: secondsAgo(120), seconds_since_last_ack: 120, acks_recent: 0,
  }));
  return {
    ...base,
    agents,
    edges: [],
    totals: {
      agents: agents.length,
      by_state: { idle: agents.length },
      flagged: {},
      in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0,
    },
  };
}

export function mockChain(traceId: string) {
  return {
    trace_id: traceId,
    observed_at: iso(0),
    truncated: false,
    nodes: [
      { tenant_id: 'Steven', alias: 'zeus', hop_count: 0, delegated: 2, received: 0, open_branches: 0 },
      { tenant_id: 'Steven', alias: 'socrates', hop_count: 1, delegated: 1, received: 1, open_branches: 1 },
      { tenant_id: 'Miguel', alias: 'janus', hop_count: 2, delegated: 0, received: 1, open_branches: 0 },
    ],
    edges: [
      {
        source: { tenant_id: 'Steven', alias: 'zeus', delivery_id: '1c0ffee0-0001-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'done' },
        target: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started', terminal_at: null },
        output_index: 0, state: 'materialized', rejection_code: null,
        hop_count: 1, hop_budget: 6, visited_depth: 1, open: true,
        response: { decision: 'allow', reason: 'acl allow_route', outcome: 'delivered' },
        root_message_id: 'msg-root-1', created_at: secondsAgo(220),
      },
      {
        source: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started' },
        target: { redacted: true as const, node_id: 'opaque-9f31c0a4b7' },
        output_index: 1, state: 'materialized', rejection_code: null,
        hop_count: 2, hop_budget: 6, visited_depth: 2, open: false,
        response: { decision: 'allow', reason: 'acl allow_route', outcome: 'delivered' },
        root_message_id: 'msg-root-1', created_at: secondsAgo(140),
      },
      {
        source: { tenant_id: 'Steven', alias: 'socrates', delivery_id: '1c0ffee0-0002-4000-8000-a1b2c3d4e5f6', attempt: 1, status: 'started' },
        target: null,
        output_index: 2, state: 'rejected', rejection_code: 'hop_budget_exhausted',
        hop_count: 6, hop_budget: 6, visited_depth: 6, open: false,
        response: null, root_message_id: 'msg-root-1', created_at: secondsAgo(90),
      },
    ],
    origin_relays: [],
    counters: { edges: 3, hidden_edges: 1, redacted_endpoints: 1, open_branches: 1, rejected_branches: 1 },
  };
}

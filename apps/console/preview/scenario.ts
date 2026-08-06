import type { FleetActivityAgent, FleetActivitySnapshot } from '../src/api/types';

/**
 * Guion del preview. Los 16 alias son los REALES de producción (tenant, alias y arnés salen de
 * `GET /v3/console/activity` del 2026-08-06); lo simulado es únicamente **qué está haciendo cada
 * uno**, para que los siete estados y las delegaciones se puedan ver sin esperar a que la flota
 * los produzca sola.
 *
 * Esto NO es la consola leyendo producción: es el mismo componente que se despliega, alimentado
 * por un guion. La página lo dice arriba de todo.
 */

export const ROSTER: Array<{ tenant: string; alias: string; harness: string }> = [
  { tenant: 'Isa', alias: 'salva', harness: 'codex' },
  { tenant: 'Jhon', alias: 'hegel', harness: 'openclaw' },
  { tenant: 'Jhon', alias: 'heraclito', harness: 'openclaw' },
  { tenant: 'Miguel', alias: 'atlas', harness: 'codex' },
  { tenant: 'Miguel', alias: 'iza', harness: 'openclaw' },
  { tenant: 'Miguel', alias: 'janus', harness: 'openclaw' },
  { tenant: 'Miguel', alias: 'kratos', harness: 'codex' },
  { tenant: 'Pablo', alias: 'dedalo', harness: 'codex' },
  { tenant: 'Pablo', alias: 'midas', harness: 'openclaw' },
  { tenant: 'Pablo', alias: 'seneca', harness: 'openclaw' },
  { tenant: 'Pablo', alias: 'vulcano', harness: 'claude' },
  { tenant: 'Steven', alias: 'argos', harness: 'hermes' },
  { tenant: 'Steven', alias: 'jarvis', harness: 'openclaw' },
  { tenant: 'Steven', alias: 'kant', harness: 'codex' },
  { tenant: 'Steven', alias: 'socrates', harness: 'codex' },
  { tenant: 'Steven', alias: 'zeus', harness: 'claude' },
];

type Role =
  | { kind: 'idle' }
  | { kind: 'working'; from?: string }
  | { kind: 'saturated' }
  | { kind: 'stalled'; ageSeconds: number }
  | { kind: 'down' };

/** Cada paso del guion dura ~6 s; el ciclo completo recorre los siete estados y vuelve. */
const SCRIPT: Array<Record<string, Role>> = [
  // 0 — la flota tranquila, salvo un caído que ya venía de antes.
  { 'Jhon/heraclito': { kind: 'down' } },
  // 1 — a kant le entra trabajo (aparece un delivery nuevo → pulso "recibiendo").
  { 'Jhon/heraclito': { kind: 'down' }, 'Steven/kant': { kind: 'working' } },
  // 2 — kant delega en kratos y en midas; los dos empiezan a trabajar.
  {
    'Jhon/heraclito': { kind: 'down' },
    'Steven/kant': { kind: 'working' },
    'Miguel/kratos': { kind: 'working', from: 'Steven/kant' },
    'Pablo/midas': { kind: 'working', from: 'Steven/kant' },
  },
  // 3 — zeus arranca su turno y socrates se satura; kratos sigue.
  {
    'Jhon/heraclito': { kind: 'down' },
    'Steven/kant': { kind: 'working' },
    'Miguel/kratos': { kind: 'working', from: 'Steven/kant' },
    'Steven/zeus': { kind: 'working' },
    'Steven/socrates': { kind: 'saturated' },
  },
  // 4 — midas cerró (pulso "respondiendo") y jarvis queda trabado hace 41 minutos.
  {
    'Jhon/heraclito': { kind: 'down' },
    'Steven/kant': { kind: 'working' },
    'Miguel/kratos': { kind: 'working', from: 'Steven/kant' },
    'Steven/zeus': { kind: 'working' },
    'Steven/socrates': { kind: 'saturated' },
    'Steven/jarvis': { kind: 'stalled', ageSeconds: 2460 },
  },
  // 5 — kratos devuelve el trabajo; jarvis sigue trabado; salva recibe de zeus.
  {
    'Jhon/heraclito': { kind: 'down' },
    'Steven/zeus': { kind: 'working' },
    'Isa/salva': { kind: 'working', from: 'Steven/zeus' },
    'Steven/jarvis': { kind: 'stalled', ageSeconds: 2760 },
  },
  // 6 — vuelve la calma; sólo queda el caído y el trabado, que es como se ve un problema real.
  {
    'Jhon/heraclito': { kind: 'down' },
    'Steven/jarvis': { kind: 'stalled', ageSeconds: 3060 },
  },
];

export const STEP_MS = 6000;
export const SCRIPT_LENGTH = SCRIPT.length;

function baseAgent(entry: typeof ROSTER[number], nowIso: string): FleetActivityAgent {
  return {
    tenant_id: entry.tenant,
    alias: entry.alias,
    display_name: `${entry.alias} (${entry.harness})`,
    harness_id: entry.harness,
    registered: true,
    agent_enabled: true,
    presence: { online: true, epoch: 27, last_heartbeat_at: nowIso, lease_until: nowIso },
    work_state: 'idle',
    flags: [],
    in_flight: 0,
    started: 0,
    claimed_not_started: 0,
    queued: 0,
    queued_ready: 0,
    retrying: 0,
    overdue_in_flight: 0,
    acks_recent: 0,
    in_flight_items: [],
  };
}

export function scenarioSnapshot(step: number): FleetActivitySnapshot {
  const nowIso = new Date().toISOString();
  const roles = SCRIPT[step % SCRIPT.length];
  const byState: Record<string, number> = {};
  let inFlight = 0;

  const agents = ROSTER.map((entry) => {
    const agent = baseAgent(entry, nowIso);
    const role = roles[`${entry.tenant}/${entry.alias}`] ?? { kind: 'idle' as const };

    if (role.kind === 'down') {
      agent.presence = { online: false, lease_until: nowIso };
      agent.flags = ['lease_expired'];
    } else if (role.kind === 'stalled') {
      agent.work_state = 'stalled';
      agent.in_flight = 1;
      agent.started = 1;
      agent.oldest_in_flight_seconds = role.ageSeconds;
      agent.seconds_since_last_ack = role.ageSeconds;
      agent.flags = ['ack_stalled'];
      agent.in_flight_items = [{ delivery_id: `stall-${entry.alias}`, status: 'started', lane: 'interactive', seconds_in_flight: role.ageSeconds }];
    } else if (role.kind === 'saturated') {
      agent.work_state = 'saturated';
      agent.in_flight = 9;
      agent.started = 9;
      agent.flags = ['saturated'];
      agent.in_flight_items = Array.from({ length: 3 }, (_, index) => ({
        delivery_id: `sat-${entry.alias}-${step}-${index}`, status: 'started', lane: 'batch',
      }));
    } else if (role.kind === 'working') {
      agent.work_state = 'working';
      agent.in_flight = 1;
      agent.started = 1;
      const [fromTenant, fromAlias] = (role.from ?? `${entry.tenant}/${entry.alias}`).split('/');
      agent.in_flight_items = [{
        delivery_id: `run-${entry.alias}-${step}`,
        status: 'started',
        lane: 'interactive',
        from_tenant: fromTenant,
        from_alias: fromAlias,
        origin_adapter: role.from ? 'bus' : 'telegram',
        seconds_in_flight: 40,
      }];
    }

    inFlight += agent.in_flight ?? 0;
    byState[agent.work_state ?? 'idle'] = (byState[agent.work_state ?? 'idle'] ?? 0) + 1;
    return agent;
  });

  return {
    observed_at: nowIso,
    thresholds: {
      saturation_in_flight: 8,
      stall_after_seconds: 300,
      ack_recent_seconds: 300,
      ack_lookback_seconds: 3600,
      items_per_agent: 10,
    },
    totals: { agents: agents.length, in_flight: inFlight, queued: 0, retrying: 0, overdue_in_flight: 0, by_state: byState },
    agents,
  };
}

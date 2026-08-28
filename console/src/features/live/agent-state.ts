import type {
  FleetActivityAgent,
  FleetActivityThresholds,
} from '../../api/types';
import {
  humanSeconds,
  plural,
  type Pulse,
  type OrigenEncargo,
} from './agent-state-helpers';

/**
 * Los siete estados que la consola distingue, cada uno con su muñeco. El orden del
 * union es el de precedencia: `down` gana a todo, `idle` pierde con todo.
 *
 * Un lease vivo no prueba que el agente responda: `blocked` se deriva de señales de estancamiento
 * (`work_state: 'stalled'`, `ack_stalled`, `overdue_acks`), y `down` se declara cuando el
 * lease venció o nunca hubo conexión.
 */
export type LiveState =
  | 'down'
  | 'blocked'
  | 'delegating'
  | 'settled'
  | 'receiving'
  | 'thinking'
  | 'idle';

export const LIVE_STATES: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'settled', 'receiving', 'thinking', 'idle',
];

export interface LiveStateMeta {
  label: string;
  /** Una línea, en castellano, que explica qué está pasando sin jerga de base de datos. */
  hint: string;
  tone: 'neutral' | 'info' | 'positive' | 'warning' | 'danger';
}

export const LIVE_STATE_META: Record<LiveState, LiveStateMeta> = {
  down: { label: 'Caído', hint: 'Sin lease vigente o nunca conectó: nadie va a tomar su trabajo.', tone: 'danger' },
  blocked: { label: 'Trabado', hint: 'Tomó trabajo y no avanza. Es el fallo que se ve como "tarda", no como error.', tone: 'danger' },
  delegating: { label: 'Delegando', hint: 'Le pasó trabajo a otro agente, que ya lo tiene en vuelo.', tone: 'info' },
  settled: {
    label: 'Salió de vuelo',
    hint: 'Una entrega suya dejó de estar en vuelo. Si cerró bien o se murió NO se puede saber desde la consola.',
    tone: 'neutral',
  },
  receiving: { label: 'Recibiendo', hint: 'Le entró trabajo nuevo y todavía no empezó el turno.', tone: 'info' },
  thinking: { label: 'Trabajando', hint: 'Turno en curso: el arnés está masticando la entrega.', tone: 'positive' },
  idle: {
    label: 'Libre',
    hint: 'Nada en vuelo. En el mapa, además, con lease vigente: un alias sin trabajo Y sin lease se dibuja Caído, que gana.',
    tone: 'neutral',
  },
};

export const STATE_ACCENT: Record<LiveState, string> = {
  down: 'var(--red)',
  blocked: 'var(--amber)',
  delegating: 'var(--violet)',
  settled: 'var(--muted)',
  receiving: 'var(--blue)',
  thinking: 'var(--mint)',
  idle: 'var(--faint)',
};

/** Cuánto dura en pantalla un estado transitorio antes de caer al estado estable. */
export const BURST_MS = 4500;

export function agentKey(agent: { tenant_id: string; alias: string }): string {
  return `${agent.tenant_id}/${agent.alias}`;
}

export interface LiveAgentView {
  key: string;
  tenantId: string;
  alias: string;
  displayName?: string | null;
  harnessId?: string | null;
  state: LiveState;
  /** Motivo concreto y verificable del estado, para el tooltip y el lector de pantalla. */
  reason: string;
  /** `working` con `in_flight >= saturation_in_flight`: el muñeco piensa, pero recalentado. */
  overloaded: boolean;
  inFlight: number;
  queued: number;
  oldestInFlightSeconds?: number | null;
  secondsSinceLastAck?: number | null;
  delegatesTo: string[];
  delegatedFrom: string[];
  flags: string[];
  /**
   * Entregas cerradas en 24 h, o `undefined` si el servidor no lo informa.
   */
  closed24h?: number;
  rooms: string[];
  origenes: OrigenEncargo[];
  agent: FleetActivityAgent;
}

export interface LiveStateContext {
  pulses?: readonly Pulse[];
  delegatesTo?: readonly string[];
  thresholds?: FleetActivityThresholds | null;
  nowMs: number;
}

/**
 * El estado del muñeco. Precedencia explícita, de arriba abajo, y cada rama deja escrito POR QUÉ
 * decidió eso: si mañana un muñeco miente, el motivo dice contra qué campo contrastarlo.
 */
export function liveState(
  agent: FleetActivityAgent,
  context: LiveStateContext,
): { state: LiveState; reason: string; overloaded: boolean } {
  const decidido = decidirEstado(agent, context);
  const flags = agent.flags ?? [];
  const sinRegistro = flags.includes('unregistered') || agent.registered === false;
  if (!sinRegistro) return decidido;
  return {
    ...decidido,
    reason: `${decidido.reason} No está en el registro de agentes: apareció por entregas o por lease.`,
  };
}

function decidirEstado(
  agent: FleetActivityAgent,
  context: LiveStateContext,
): { state: LiveState; reason: string; overloaded: boolean } {
  const flags = agent.flags ?? [];
  const saturation = context.thresholds?.saturation_in_flight ?? 8;
  const stallAfter = context.thresholds?.stall_after_seconds ?? 300;
  const inFlight = agent.in_flight ?? 0;
  const overloaded = inFlight >= saturation;

  const sinRegistro = flags.includes('unregistered') || agent.registered === false;

  if (agent.agent_enabled === false && !sinRegistro) {
    return { state: 'down', reason: 'Deshabilitado en el registro de agentes: no se le asigna trabajo.', overloaded };
  }
  if (flags.includes('never_connected')) {
    return { state: 'down', reason: 'Nunca abrió una conexión: no hay lease de este alias.', overloaded };
  }
  if (flags.includes('lease_expired') || agent.presence?.online === false) {
    return { state: 'down', reason: 'El lease venció. El adaptador no está sosteniendo la conexión.', overloaded };
  }

  if (agent.work_state === 'stalled') {
    const age = agent.oldest_in_flight_seconds;
    return {
      state: 'blocked',
      reason: typeof age === 'number'
        ? `Tomó una entrega hace ${humanSeconds(age)} y no la cerró (umbral: ${humanSeconds(stallAfter)}).`
        : 'El servidor lo marcó estancado: trabajo tomado que no avanza.',
      overloaded,
    };
  }
  if (flags.includes('overdue_acks')) {
    return { state: 'blocked', reason: 'Tiene entregas con el deadline de ACK vencido: el turno se le está muriendo.', overloaded };
  }
  if (flags.includes('ack_stalled')) {
    const since = agent.seconds_since_last_ack;
    return {
      state: 'blocked',
      reason: since === null || since === undefined
        ? 'Trabajo en vuelo y ningún ACK dentro de la ventana de búsqueda: la señal más grave.'
        : `Trabajo en vuelo y el último ACK fue hace ${humanSeconds(since)}.`,
      overloaded,
    };
  }
  if (flags.includes('queued_without_consumer')) {
    return { state: 'blocked', reason: 'Tiene cola encolada y ningún consumidor conectado que la tome.', overloaded };
  }

  const pulses = context.pulses ?? [];
  const received = pulses.find((pulse) => pulse.kind === 'received');
  const settled = pulses.find((pulse) => pulse.kind === 'settled' && pulse.outcome === 'deadline_vencido')
    ?? pulses.find((pulse) => pulse.kind === 'settled');

  if (settled && context.nowMs - settled.atMs < BURST_MS) {
    return {
      state: 'settled',
      reason: settled.outcome === 'deadline_vencido'
        ? 'Una entrega suya salió de vuelo con el deadline de ACK ya vencido: no fue un cierre limpio.'
        : 'Una entrega suya salió de vuelo en el último refresco. Si cerró bien o se murió no se puede '
          + 'saber desde acá: /activity sólo lista leased, accepted y started, así que done, failed y '
          + 'vencida por deadline se ven exactamente igual.',
      overloaded,
    };
  }

  const delegatesTo = context.delegatesTo ?? [];
  if (delegatesTo.length > 0) {
    return {
      state: 'delegating',
      reason: `Le pasó trabajo a ${delegatesTo.map((key) => key.split('/')[1]).join(', ')}, que lo tiene en vuelo.`,
      overloaded,
    };
  }

  if (received && context.nowMs - received.atMs < BURST_MS) {
    return { state: 'receiving', reason: 'Le entró una entrega nueva en el último refresco.', overloaded };
  }

  const claimedNotStarted = agent.claimed_not_started ?? 0;
  if (claimedNotStarted > 0 && (agent.started ?? 0) === 0) {
    return { state: 'receiving', reason: `${plural(claimedNotStarted, 'entrega tomada', 'entregas tomadas')} y todavía sin empezar.`, overloaded };
  }

  if (agent.work_state === 'working' || agent.work_state === 'saturated' || inFlight > 0) {
    return {
      state: 'thinking',
      reason: overloaded
        ? `${plural(inFlight, 'entrega', 'entregas')} en vuelo: por encima del umbral de saturación (${String(saturation)}).`
        : `${plural(inFlight, 'entrega', 'entregas')} en vuelo.`,
      overloaded,
    };
  }

  if ((agent.queued ?? 0) > 0) {
    return { state: 'receiving', reason: `${plural(agent.queued ?? 0, 'entrega esperando', 'entregas esperando')} en cola.`, overloaded };
  }

  return { state: 'idle', reason: 'Conectado, con lease vigente y nada en vuelo.', overloaded };
}

/** Cuenta por estado, para la barra de resumen. Siempre publica los siete, incluso en cero. */
export function stateTally(views: readonly LiveAgentView[]): Record<LiveState, number> {
  const tally = Object.fromEntries(LIVE_STATES.map((state) => [state, 0])) as Record<LiveState, number>;
  for (const view of views) tally[view.state] += 1;
  return tally;
}

// ==============================================================================================
// El veredicto, y lo que hace falta para poder emitirlo honestamente.
// ==============================================================================================

/**
 * Los siete estados son la verdad del sistema; estos tres son la pregunta del dueño.
 */
export type OwnerBucket = 'problema' | 'ocupado' | 'libre';

export function ownerBucket(state: LiveState): OwnerBucket {
  if (state === 'down' || state === 'blocked') return 'problema';
  if (state === 'idle') return 'libre';
  return 'ocupado';
}

export const ROTULO_OCUPADOS = 'con trabajo entre manos';

export interface VerdictCulprit {
  key: string;
  alias: string;
  /** Frase corta y comprobable: "trabado hace 22 min", "caído". Es lo que va dentro del chip. */
  motivo: string;
}

export interface Verdict {
  tone: 'ok' | 'alerta' | 'desconocido';
  /** Una sola frase, la que se lee en tres segundos. */
  frase: string;
  /** La línea de apoyo, con las cifras que sostienen la frase. */
  apoyo: string;
  culpables: VerdictCulprit[];
}

export interface VerdictInput {
  /** La última lectura falló. Basta por sí solo para que el veredicto NO sea verde. */
  error?: Error | null;
  /** `observed_at` del snapshot que se está mostrando. */
  observedAt?: string | null;
  nowMs: number;
  /** A partir de qué antigüedad el snapshot deja de acreditar nada. */
  staleAfterMs: number;
}

function motivoDe(view: LiveAgentView): string {
  if (view.state === 'down') return 'caído';
  const edad = view.oldestInFlightSeconds;
  if (typeof edad === 'number') return `trabado hace ${humanSeconds(edad)}`;
  const ack = view.secondsSinceLastAck;
  if (ack === null || ack === undefined) return 'trabado, sin una sola señal';
  return `trabado, último ACK hace ${humanSeconds(ack)}`;
}

function horaCorta(marca: number): string {
  return new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(marca));
}

export function fleetVerdict(views: readonly LiveAgentView[], input: VerdictInput): Verdict {
  const marca = typeof input.observedAt === 'string' ? Date.parse(input.observedAt) : Number.NaN;
  const edadMs = Number.isFinite(marca) ? input.nowMs - marca : Number.NaN;
  const rancio = !Number.isFinite(edadMs) || edadMs > input.staleAfterMs;

  if (input.error || rancio) {
    const desde = Number.isFinite(marca)
      ? `Datos de hace ${humanSeconds(Math.max(0, edadMs) / 1000)} (última lectura buena ${horaCorta(marca)}).`
      : 'Todavía no llegó ninguna lectura con hora del servidor.';
    return {
      tone: 'desconocido',
      frase: input.error ? 'No lo sé: la última lectura falló.' : 'No lo sé: el dato está viejo.',
      apoyo: desde,
      culpables: [],
    };
  }

  if (views.length === 0) {
    return {
      tone: 'desconocido',
      frase: 'No lo sé: no hay ni un alias que mirar.',
      apoyo: 'La lectura llegó fresca pero no trae ningún agente en este alcance. Cero mediciones no es lo mismo que cero problemas.',
      culpables: [],
    };
  }

  const problemas = views.filter((view) => ownerBucket(view.state) === 'problema');
  const countPlural = (cuantos: number, uno: string, varios: string) => `${String(cuantos)} ${cuantos === 1 ? uno : varios}`;
  const ocupados = views.filter((view) => ownerBucket(view.state) === 'ocupado').length;
  const libres = views.filter((view) => ownerBucket(view.state) === 'libre').length;
  const conectados = views.filter((view) => view.state !== 'down').length;

  if (problemas.length > 0) {
    return {
      tone: 'alerta',
      frase: problemas.length === 1
        ? '1 agente necesita atención.'
        : `${String(problemas.length)} agentes necesitan atención.`,
      apoyo: `${countPlural(conectados, 'conectado', 'conectados')} · ${String(ocupados)} ${ROTULO_OCUPADOS} · ${countPlural(libres, 'libre', 'libres')}.`,
      culpables: problemas.map((view) => ({ key: view.key, alias: view.alias, motivo: motivoDe(view) })),
    };
  }

  return {
    tone: 'ok',
    frase: 'Todo en orden.',
    apoyo: `${countPlural(conectados, 'conectado', 'conectados')} · ${String(ocupados)} ${ROTULO_OCUPADOS} · ${countPlural(libres, 'libre', 'libres')} · ninguno trabado.`,
    culpables: [],
  };
}

export {
  aliasDe,
  plural,
  humanSeconds,
  delegationEdges,
  type DelegationEdge,
  type ItemMemory,
  type AgentMemory,
  type FleetMemory,
  rememberFleet,
  type PulseOutcome,
  type Pulse,
  type PulseMap,
  detectPulses,
  buildLiveViews,
  type EdgeAggregate,
  edgePairKey,
  aggregateEdges,
  type HumanOrigin,
  type OrigenEncargo,
  origenDeItem,
  origenesDeAgente,
  humanOrigins,
  AVATAR_UNIFORME,
  AVATAR_MIN,
  AVATAR_MAX,
  radioDe,
  grosorDe,
} from './agent-state-helpers';

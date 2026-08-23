import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent } from '../../api/types';
import {
  agentRowKey, formatAckAge, formatDurationSeconds, formatInFlightAge, presenceBadge, rowUrgency, sortByUrgency,
} from './activity';

function agent(overrides: Partial<FleetActivityAgent>): FleetActivityAgent {
  return { tenant_id: 'Steven', alias: 'kant', ...overrides };
}

describe('formatDurationSeconds', () => {
  it('renders UNKNOWN for null/undefined/non-finite input, never a bare number', () => {
    expect(formatDurationSeconds(null)).toBe('UNKNOWN');
    expect(formatDurationSeconds(undefined)).toBe('UNKNOWN');
    expect(formatDurationSeconds(Number.NaN)).toBe('UNKNOWN');
  });

  it('scales the unit to the magnitude', () => {
    expect(formatDurationSeconds(45)).toBe('45s');
    expect(formatDurationSeconds(125)).toBe('2m 5s');
    expect(formatDurationSeconds(4820)).toBe('1h 20m');
  });

  it('keeps the sign instead of silently flipping an overdue (negative) duration', () => {
    expect(formatDurationSeconds(-90)).toBe('-1m 30s');
  });
});

describe('formatAckAge — el caso que no puede leerse como "recién ackeado"', () => {
  it('never renders null as zero or a dash: it always says explicitly there was no ACK', () => {
    const text = formatAckAge(null, 3600);
    expect(text).not.toBe('0');
    expect(text).not.toBe('-');
    expect(text.toLowerCase()).toContain('ack');
    expect(text).toContain('1h 0m');
  });

  it('sin ventana de búsqueda lo dice en castellano, no con un UNKNOWN de base de datos', () => {
    // Sigue siendo el mismo hecho —no hay ACK y no se sabe desde cuándo— dicho con palabras que
    // el operador entiende sin saber qué es un `ack_lookback_seconds`.
    expect(formatAckAge(null, null)).toBe('ningún ACK, y el servidor no dice desde cuándo');
    expect(formatAckAge(null, null).toLowerCase()).toContain('ack');
  });

  it('renders a real elapsed time when the ACK is known', () => {
    expect(formatAckAge(12, 3600)).toBe('hace 12s');
  });
});

describe('formatInFlightAge — distingue cero conocido de desconocido', () => {
  it('renders a dash (not UNKNOWN) when there is nothing in flight', () => {
    expect(formatInFlightAge(null)).toBe('—');
  });

  it('renders the real age when something is in flight', () => {
    expect(formatInFlightAge(259)).toBe('4m 19s');
  });
});

describe('rowUrgency', () => {
  it('flags stalled as critical and saturated as warning, everything else as none', () => {
    expect(rowUrgency('stalled')).toBe('critical');
    expect(rowUrgency('saturated')).toBe('warning');
    expect(rowUrgency('working')).toBeUndefined();
    expect(rowUrgency('queued')).toBeUndefined();
    expect(rowUrgency('idle')).toBeUndefined();
    expect(rowUrgency(null)).toBeUndefined();
  });
});

describe('sortByUrgency', () => {
  it('surfaces stalled and saturated agents above idle ones, tie-broken by in_flight', () => {
    const agents = [
      agent({ alias: 'idle-one', work_state: 'idle', in_flight: 0 }),
      agent({ alias: 'working-small', work_state: 'working', in_flight: 3 }),
      agent({ alias: 'midas', work_state: 'stalled', in_flight: 41 }),
      agent({ alias: 'atlas', work_state: 'queued', in_flight: 0 }),
      agent({ alias: 'working-big', work_state: 'working', in_flight: 8 }),
    ];

    const order = sortByUrgency(agents).map((entry) => entry.alias);
    expect(order).toEqual(['midas', 'working-big', 'working-small', 'atlas', 'idle-one']);
  });

  it('never hides an agent whose work_state is missing behind the ones the server did classify', () => {
    const agents = [
      agent({ alias: 'classified', work_state: 'stalled', in_flight: 5 }),
      agent({ alias: 'unclassified', work_state: undefined, in_flight: 0 }),
    ];
    expect(sortByUrgency(agents)[0].alias).toBe('unclassified');
  });

  it('does not mutate the input array', () => {
    const agents = [agent({ alias: 'b', work_state: 'idle' }), agent({ alias: 'a', work_state: 'stalled' })];
    const copy = [...agents];
    sortByUrgency(agents);
    expect(agents).toEqual(copy);
  });
});

describe('presenceBadge', () => {
  it('distinguishes never-connected (no presence object) from a lease with unreadable expiry', () => {
    const neverConnected = agent({ presence: undefined });
    const unreadableLease = agent({ presence: { lease_until: null } });
    // Las mismas palabras que el resto de la consola: «Nunca conectó» es también el rótulo de la
    // señal `never_connected`, y «Sin dato» no se confunde con «no hay».
    expect(presenceBadge(neverConnected).label).toBe('Nunca conectó');
    expect(presenceBadge(unreadableLease).label).toBe('Sin dato');
  });

  it('lee conectado/caído de lease_until contra el reloj, con la palabra del veredicto', () => {
    const online = agent({ presence: { lease_until: new Date(Date.now() + 60_000).toISOString() } });
    const expired = agent({ presence: { lease_until: new Date(Date.now() - 60_000).toISOString() } });
    expect(presenceBadge(online).label).toBe('Conectado');
    // «Caído» y no «EXPIRADO»: es exactamente lo que el veredicto de arriba llama caído y lo que
    // la leyenda del pie explica como caído. Eran tres palabras para el mismo hecho.
    expect(presenceBadge(expired).label).toBe('Caído');
  });
});

describe('agentRowKey', () => {
  it('is stable and unique per tenant+alias', () => {
    expect(agentRowKey(agent({ tenant_id: 'Pablo', alias: 'midas' }))).toBe('Pablo:midas');
  });
});

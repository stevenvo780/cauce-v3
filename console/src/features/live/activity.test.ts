import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent } from '../../api/types';
import { UNKNOWN } from '../../lib';
import { FLAG_LABEL, WORK_STATE_LABEL, formatAckAge, formatDurationSeconds, sortByUrgency } from './activity';
import { LIVE_STATE_META } from './agent-state';

function agent(overrides: Partial<FleetActivityAgent>): FleetActivityAgent {
  return { tenant_id: 'Steven', alias: 'kant', ...overrides };
}

describe('formatDurationSeconds', () => {
  it('dice que no hay dato en vez de un número desnudo, para null/undefined/no-finito', () => {
    expect(formatDurationSeconds(null)).toBe(UNKNOWN);
    expect(formatDurationSeconds(undefined)).toBe(UNKNOWN);
    expect(formatDurationSeconds(Number.NaN)).toBe(UNKNOWN);
    // The exact word, so a vocabulary change has to be deliberate.
    expect(UNKNOWN).toBe('sin dato');
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

  it('without a search window it says it in Spanish, not with a database UNKNOWN', () => {
    // Still the same fact — no ACK and it is not known since when — said with words the
    // operator understands without knowing what `ack_lookback_seconds` is.
    expect(formatAckAge(null, null)).toBe('ningún ACK, y el servidor no dice desde cuándo');
    expect(formatAckAge(null, null).toLowerCase()).toContain('ack');
    expect(formatAckAge(null, null)).not.toContain('UNKNOWN');
    expect(formatAckAge(null, null)).not.toBe('0');
    expect(formatAckAge(null, null)).not.toBe('—');
  });

  it('renders a real elapsed time when the ACK is known', () => {
    expect(formatAckAge(12, 3600)).toBe('hace 12s');
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

/* ============================================================================================ *
 * Negative control of the vocabulary: ONE label per fact, and the same words across the screen.
 * See `WORK_STATE_LABEL` and `FLAG_LABEL` in `activity.ts`.
 * ============================================================================================ */

describe('un solo vocabulario en toda la vista', () => {
  it('la tabla y el glosario del mapa llaman IGUAL a lo mismo', () => {
    // These four are the matches the operator sees side by side. If someone renames one end
    // without the other, the three words for the same state come back.
    expect(WORK_STATE_LABEL.idle).toBe(LIVE_STATE_META.idle.label);
    expect(WORK_STATE_LABEL.working).toBe(LIVE_STATE_META.thinking.label);
    expect(WORK_STATE_LABEL.stalled).toBe(LIVE_STATE_META.blocked.label);
    expect(WORK_STATE_LABEL.queued).toBe(LIVE_STATE_META.receiving.label);
    // And the expired lease is said "Caido", same as the map's state.
    expect(FLAG_LABEL.lease_expired).toBe(LIVE_STATE_META.down.label);
  });

  it('ninguna etiqueta va en MAYÚSCULAS SOSTENIDAS ni en inglés crudo', () => {
    for (const [clave, texto] of [...Object.entries(WORK_STATE_LABEL), ...Object.entries(FLAG_LABEL)]) {
      expect(texto, `${clave} está en mayúsculas sostenidas`).not.toBe(texto.toUpperCase());
      expect(texto, `${clave} lleva un identificador crudo`).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

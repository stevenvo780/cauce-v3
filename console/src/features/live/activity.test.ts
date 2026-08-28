import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent } from '../../api/types';
import { UNKNOWN } from '../../lib';
import {
  FLAG_LABEL, WORK_STATE_LABEL, agentRowKey, formatAckAge, formatDurationSeconds, formatInFlightAge,
  presenceBadge, resumirSenales, rowUrgency, sortByUrgency,
} from './activity';
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
    // The same words as the rest of the console: "Nunca conecto" is also the label of the
    // `never_connected` signal, and "Sin dato" is not confused with "no hay".
    expect(presenceBadge(neverConnected).label).toBe('Nunca conectó');
    expect(presenceBadge(unreadableLease).label).toBe('Sin dato');
  });

  it('lee conectado/caído de lease_until contra el reloj, con la palabra del veredicto', () => {
    const online = agent({ presence: { lease_until: new Date(Date.now() + 60_000).toISOString() } });
    const expired = agent({ presence: { lease_until: new Date(Date.now() - 60_000).toISOString() } });
    expect(presenceBadge(online).label).toBe('Conectado');
    // "Caido" and not "EXPIRADO": it is exactly what the verdict above calls down and what
    // the footer legend explains as down. Three words for the same fact.
    expect(presenceBadge(expired).label).toBe('Caído');
  });
});

describe('agentRowKey', () => {
  it('is stable and unique per tenant+alias', () => {
    expect(agentRowKey(agent({ tenant_id: 'Pablo', alias: 'midas' }))).toBe('Pablo:midas');
  });
});


/* ============================================================================================ *
 * Negative control of the vocabulary: ONE label per fact, and the same words across the screen.
 * See `resumirSenales` and `WORK_STATE_LABEL` in `activity.ts`.
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

describe('resumirSenales — el control negativo de las insignias apiladas', () => {
  it('jarvis: SATURADO no se pinta dos veces en la misma celda', () => {
    /*
     * "Saturado" appears ONCE, and the word that accompanies it does not repeat it.
     *
     * `work_state: 'saturated'` is labelled "Trabajando" on purpose (`WORK_STATE_LABEL`): among
     * the bot's seven states none is called "Saturado", because saturation is a SIGNAL and the
     * server sends it separately in `flags`. Putting "Saturado" in the title as well invented an
     * eighth state that the legend does not explain, and left the cell reading "SATURADO
     * SATURADO". Title "Trabajando" + signal "Saturado" are two distinct facts, each said once.
     */
    const resumen = resumirSenales('saturated', ['saturated']);
    const pintadas = [resumen.estado.label, ...resumen.senales.map((s) => s.label)];
    expect(pintadas).toEqual(['Trabajando', 'Saturado']);
    expect(new Set(pintadas).size).toBe(pintadas.length);
    // The implicated part is not lost: it stays intact in the `title=`.
    expect(resumen.detalle).toContain('Saturado');
  });

  it('the title rules: if the row already says "Saturado", the chip does not repeat it', () => {
    // The real row paints the DERIVED state (`estadoDeFila`) and passes it as the title. If that
    // title said "Saturado", the signal chip would be the same word twice and collapses.
    const resumen = resumirSenales('saturated', ['saturated'], 'conectado', {
      clave: 'x', label: 'Saturado', tone: 'warning',
    });
    expect([resumen.estado.label, ...resumen.senales.map((s) => s.label)]).toEqual(['Saturado']);
  });

  it('midas: cinco insignias para decir «está trabado» pasan a tres', () => {
    const resumen = resumirSenales('stalled', ['ack_stalled', 'saturated', 'overdue_acks', 'lease_expired']);
    const pintadas = [resumen.estado.label, ...resumen.senales.map((s) => s.label)];
    expect(pintadas.length).toBeLessThanOrEqual(3);
    expect(pintadas[0]).toBe('Trabado');
    // No measured signal is lost: all four are still named in the detail.
    for (const flag of ['ack_stalled', 'saturated', 'overdue_acks', 'lease_expired'] as const) {
      expect(resumen.detalle).toContain(FLAG_LABEL[flag]);
    }
  });

  it('NINGUNA combinación pinta la misma palabra dos veces, ni pasa de cuatro insignias', () => {
    const estados = [undefined, 'idle', 'queued', 'working', 'saturated', 'stalled'] as const;
    const banderas = [
      'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired',
      'never_connected', 'unregistered', 'queued_without_consumer',
    ] as const;
    // The 2^7 signal combinations per state: 384 possible cells.
    for (const estado of estados) {
      for (let mascara = 0; mascara < 1 << banderas.length; mascara += 1) {
        const flags = banderas.filter((_, indice) => mascara & (1 << indice));
        const resumen = resumirSenales(estado, flags);
        const pintadas = [resumen.estado.label, ...resumen.senales.map((s) => s.label)];
        expect(new Set(pintadas).size, `duplicado con ${String(estado)}/${flags.join('+')}: ${pintadas.join(', ')}`)
          .toBe(pintadas.length);
        expect(pintadas.length + (resumen.ocultas > 0 ? 1 : 0),
          `demasiadas insignias con ${String(estado)}/${flags.join('+')}`).toBeLessThanOrEqual(4);
        // And NEVER is a measured signal lost: the detail names them all.
        for (const flag of flags) expect(resumen.detalle).toContain(FLAG_LABEL[flag]);
      }
    }
  });

  it('sin `work_state` del servidor se DICE, no se rellena con «Libre»', () => {
    const resumen = resumirSenales(undefined, []);
    expect(resumen.estado.label).toBe('Sin dato de estado');
    expect(resumen.estado.tone).toBe('unknown');
  });
});

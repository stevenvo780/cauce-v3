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
    // La palabra concreta, para que un cambio de vocabulario tenga que ser deliberado.
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

  it('sin ventana de búsqueda lo dice en castellano, no con un UNKNOWN de base de datos', () => {
    // Sigue siendo el mismo hecho —no hay ACK y no se sabe desde cuándo— dicho con palabras que
    // el operador entiende sin saber qué es un `ack_lookback_seconds`.
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


/* ============================================================================================ *
 * Control negativo del vocabulario: UNA etiqueta por hecho, y las mismas palabras en toda la
 * pantalla. Ver `resumirSenales` y `WORK_STATE_LABEL` en `activity.ts`.
 * ============================================================================================ */

describe('un solo vocabulario en toda la vista', () => {
  it('la tabla y el glosario del mapa llaman IGUAL a lo mismo', () => {
    // Estas cuatro son las coincidencias que el operador ve una al lado de la otra. Si alguien
    // renombra una punta y no la otra, vuelven las tres palabras para el mismo estado.
    expect(WORK_STATE_LABEL.idle).toBe(LIVE_STATE_META.idle.label);
    expect(WORK_STATE_LABEL.working).toBe(LIVE_STATE_META.thinking.label);
    expect(WORK_STATE_LABEL.stalled).toBe(LIVE_STATE_META.blocked.label);
    expect(WORK_STATE_LABEL.queued).toBe(LIVE_STATE_META.receiving.label);
    // Y el lease vencido se dice «Caído», igual que el estado del mapa.
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
     * «Saturado» aparece UNA vez, y la palabra que la acompaña no la repite.
     *
     * `work_state: 'saturated'` se rotula «Trabajando» a propósito (`WORK_STATE_LABEL`): entre los
     * siete estados del muñeco no hay ninguno que se llame «Saturado», porque la saturación es una
     * SEÑAL y el servidor la manda por separado en `flags`. Poner «Saturado» también en el titular
     * inventaba un octavo estado que la leyenda no explica, y dejaba la celda diciendo «SATURADO
     * SATURADO». Titular «Trabajando» + señal «Saturado» son dos hechos distintos, cada uno dicho
     * una sola vez.
     */
    const resumen = resumirSenales('saturated', ['saturated']);
    const pintadas = [resumen.estado.label, ...resumen.senales.map((s) => s.label)];
    expect(pintadas).toEqual(['Trabajando', 'Saturado']);
    expect(new Set(pintadas).size).toBe(pintadas.length);
    // Lo implicado no se pierde: sigue entero en el `title=`.
    expect(resumen.detalle).toContain('Saturado');
  });

  it('el titular manda: si la fila ya dice «Saturado», el chip no lo repite', () => {
    // La fila real pinta el estado DERIVADO (`estadoDeFila`), y se lo pasa como titular. Si ese
    // titular dijera «Saturado», el chip de la señal sería la misma palabra dos veces y se pliega.
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
    // Ninguna señal medida se pierde: las cuatro siguen nombradas en el detalle.
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
    // Las 2^7 combinaciones de señales por cada estado: 384 celdas posibles.
    for (const estado of estados) {
      for (let mascara = 0; mascara < 1 << banderas.length; mascara += 1) {
        const flags = banderas.filter((_, indice) => mascara & (1 << indice));
        const resumen = resumirSenales(estado, flags);
        const pintadas = [resumen.estado.label, ...resumen.senales.map((s) => s.label)];
        expect(new Set(pintadas).size, `duplicado con ${String(estado)}/${flags.join('+')}: ${pintadas.join(', ')}`)
          .toBe(pintadas.length);
        expect(pintadas.length + (resumen.ocultas > 0 ? 1 : 0),
          `demasiadas insignias con ${String(estado)}/${flags.join('+')}`).toBeLessThanOrEqual(4);
        // Y NUNCA se pierde una señal medida: el detalle las nombra todas.
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

import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import {
  LIVE_STATES,
  LIVE_STATE_META,
  ROTULO_OCUPADOS,
  buildLiveViews,
  fleetVerdict,
  stateTally,
} from './agent-state';

/**
 * **THE SAME WORD WITH TWO DIFFERENT NUMBERS, 140 PIXELS APART.**
 *
 * The verdict said:
 *
 *     13 conectados · 4 trabajando · 9 libres
 *
 * and the chip immediately below said **Trabajando 2**. Both numbers were right: the 4 groups
 * `thinking` + `delegating` + `receiving` + `settled`; the 2 is only `thinking`. What was wrong
 * was the WORD. And the other two figures of the verdict DID square with their chip (9 libres =
 * Libre 9; 13 conectados = 18 − Caido 5), which is what made it dangerous: the operator checks
 * two, they match, and trusts the third.
 *
 * The rule this file fixes is not "forbidden to repeat words" — "libres" and "Libre" MUST
 * coincide, because they count exactly the same —: it is that **a shared word forces a shared
 * number**. It is checked over the painted string, and not over the implementation, because
 * the bug lived exactly in the string.
 */

const AHORA = Date.parse('2026-08-23T10:00:00.000Z');
const OBSERVADO = '2026-08-23T09:59:58.000Z';

function agente(overrides: Partial<FleetActivityAgent> = {}): FleetActivityAgent {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    registered: true,
    agent_enabled: true,
    presence: { online: true, lease_until: '2026-08-23T11:00:00.000Z' },
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

/**
 * The fleet MEASURED on the day of the bug, rebuilt: 5 down, 2 working, 2 delegating and 9
 * idle. It is the only way for the test to distinguish "4 ocupados" from "2 trabajando"; with
 * a fleet in which all the busy ones were `thinking`, the two numbers would coincide by
 * chance and the guard would approve the bug.
 */
function flotaDelDefecto(): FleetActivitySnapshot {
  const agents: FleetActivityAgent[] = [];
  for (let i = 0; i < 5; i += 1) {
    agents.push(agente({ alias: `caido-${String(i)}`, flags: ['lease_expired'], presence: { online: false } }));
  }
  // Two really working: one in-flight delivery each, with nobody they have passed it to.
  for (let i = 0; i < 2; i += 1) {
    agents.push(agente({ alias: `trabajando-${String(i)}`, work_state: 'working', in_flight: 1, started: 1 }));
  }
  /*
   * Two delegating: `delegating` is derived from ANOTHER alias having in flight a delivery whose
   * sender is this one. So each delegator needs its receiver, and those receivers are the two
   * `trabajando-*` from above: `delegando-i` → `trabajando-i`.
   */
  for (let i = 0; i < 2; i += 1) {
    agents.push(agente({ alias: `delegando-${String(i)}` }));
    const receptor = agents.find((candidato) => candidato.alias === `trabajando-${String(i)}`);
    if (receptor) {
      receptor.in_flight_items = [{
        delivery_id: `d-${String(i)}`,
        from_tenant: 'Steven',
        from_alias: `delegando-${String(i)}`,
        status: 'started',
        seconds_in_flight: 12,
        ack_deadline_at: '2026-08-23T10:30:00.000Z',
      }];
    }
  }
  for (let i = 0; i < 9; i += 1) agents.push(agente({ alias: `libre-${String(i)}` }));
  return {
    observed_at: OBSERVADO,
    thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
    agents,
  };
}

/** The "number + word" pairs of the support line, as read on screen. */
function cifrasDelApoyo(apoyo: string): { numero: number; palabra: string }[] {
  return [...apoyo.matchAll(/(\d+)\s+([^·.]+)/g)].map((coincidencia) => ({
    numero: Number(coincidencia[1]),
    palabra: coincidencia[2].trim().toLowerCase(),
  }));
}

/** "libres" → "libre". Without this, the match with the chip's label would escape by the `s`. */
function singular(palabra: string): string {
  return palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
}

describe('el veredicto y los chips de /live hablan el mismo idioma', () => {
  it('ninguna palabra compartida con un chip lleva un número distinto al del chip', () => {
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const veredicto = fleetVerdict(views, { observedAt: OBSERVADO, nowMs: AHORA, staleAfterMs: 12_000 });

    // The rebuilt fleet is the measured one: if this changed, the test would stop looking at the bug.
    expect(views).toHaveLength(18);
    expect(tally.down).toBe(5);
    expect(tally.thinking).toBe(2);
    expect(tally.delegating).toBe(2);
    expect(tally.idle).toBe(9);

    const desacuerdos: string[] = [];
    for (const { numero, palabra } of cifrasDelApoyo(veredicto.apoyo)) {
      for (const estado of LIVE_STATES) {
        const rotulo = LIVE_STATE_META[estado].label.toLowerCase();
        if (singular(palabra) !== singular(rotulo)) continue;
        if (numero !== tally[estado]) {
          desacuerdos.push(
            `el veredicto dice «${String(numero)} ${palabra}» y el chip «${LIVE_STATE_META[estado].label} `
            + `${String(tally[estado])}»: misma palabra, números distintos`,
          );
        }
      }
    }
    expect(desacuerdos).toEqual([]);
  });

  it('el número de los ocupados sigue estando: se cambió la palabra, no se escondió la cifra', () => {
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const veredicto = fleetVerdict(views, { observedAt: OBSERVADO, nowMs: AHORA, staleAfterMs: 12_000 });

    expect(veredicto.apoyo).toContain(`4 ${ROTULO_OCUPADOS}`);
    expect(veredicto.apoyo).toContain('13 conectados');
    expect(veredicto.apoyo).toContain('9 libres');
  });

  it('y «libres» SÍ tiene que seguir cuadrando con el chip «Libre»: la regla no es no repetir', () => {
    // POSITIVE CONTROL. If the fix had been "change all words so none coincide", this check
    // would fall: we would lose the only figure of the verdict the operator can cross-check at
    // a glance against the tally.
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const veredicto = fleetVerdict(views, { observedAt: OBSERVADO, nowMs: AHORA, staleAfterMs: 12_000 });

    expect(veredicto.apoyo).toContain(`${String(tally.idle)} libres`);
  });

  it('CONTROL NEGATIVO — con la palabra vieja, el guardia marca el desacuerdo', () => {
    /*
     * The checker is fed the EXACT line that produced the measured bug. A guard that does not
     * flag it would be approving the bug it came looking for.
     */
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const apoyoViejo = '13 conectados · 4 trabajando · 9 libres.';

    const desacuerdos: string[] = [];
    for (const { numero, palabra } of cifrasDelApoyo(apoyoViejo)) {
      for (const estado of LIVE_STATES) {
        const rotulo = LIVE_STATE_META[estado].label.toLowerCase();
        if (singular(palabra) === singular(rotulo) && numero !== tally[estado]) {
          desacuerdos.push(`${palabra}: ${String(numero)} vs ${String(tally[estado])}`);
        }
      }
    }
    expect(desacuerdos).toEqual(['trabajando: 4 vs 2']);
  });
});

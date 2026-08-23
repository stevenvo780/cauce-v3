import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import {
  LIVE_STATES,
  LIVE_STATE_META,
  ROTULO_OCUPADOS,
  buildLiveViews,
  fleetVerdict,
  stateTally,
  type LiveState,
} from './agent-state';

/**
 * **LA MISMA PALABRA CON DOS NÚMEROS DISTINTOS, A 140 PÍXELES DE DISTANCIA.**
 *
 * 🔴 Medido el 2026-08-23 en producción con 18 alias. El veredicto decía:
 *
 *     13 conectados · 4 trabajando · 9 libres
 *
 * y el chip inmediatamente debajo decía **Trabajando 2**. Las dos cifras estaban bien: el 4
 * agrupa `thinking` + `delegating` + `receiving` + `settled`; el 2 es sólo `thinking`. Lo que
 * estaba mal era la PALABRA. Y las otras dos cifras del veredicto sí cuadraban con su chip (9
 * libres = Libre 9; 13 conectados = 18 − Caído 5), que es lo que lo hacía peligroso: el operador
 * comprueba dos, le cuadran, y se fía de la tercera.
 *
 * La regla que fija este fichero no es «prohibido repetir palabras» —«libres» y «Libre» SÍ deben
 * coincidir, porque cuentan exactamente lo mismo—: es que **una palabra compartida obliga a un
 * número compartido**. Se comprueba sobre la cadena que se pinta, y no sobre la implementación,
 * porque el defecto vivía justamente en la cadena.
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
 * La flota MEDIDA el día del defecto, reconstruida: 5 caídos, 2 trabajando, 2 delegando y 9
 * libres. Es la única forma de que la prueba distinga «4 ocupados» de «2 trabajando»; con una
 * flota en la que todos los ocupados estuvieran `thinking`, los dos números coincidirían por
 * casualidad y el guardia aprobaría el defecto.
 */
function flotaDelDefecto(): FleetActivitySnapshot {
  const agents: FleetActivityAgent[] = [];
  for (let i = 0; i < 5; i += 1) {
    agents.push(agente({ alias: `caido-${i}`, flags: ['lease_expired'], presence: { online: false } }));
  }
  // Dos trabajando de verdad: una entrega en vuelo cada uno, sin nadie a quien se la hayan pasado.
  for (let i = 0; i < 2; i += 1) {
    agents.push(agente({ alias: `trabajando-${i}`, work_state: 'working', in_flight: 1, started: 1 }));
  }
  /*
   * Dos delegando: `delegating` se deriva de que OTRO alias tenga en vuelo una entrega cuyo
   * emisor es éste. Así que cada delegador necesita su receptor, y esos receptores son los dos
   * `trabajando-*` de arriba: `delegando-i` → `trabajando-i`.
   */
  for (let i = 0; i < 2; i += 1) {
    agents.push(agente({ alias: `delegando-${i}` }));
    const receptor = agents.find((candidato) => candidato.alias === `trabajando-${i}`);
    if (receptor) {
      receptor.in_flight_items = [{
        delivery_id: `d-${i}`,
        from_tenant: 'Steven',
        from_alias: `delegando-${i}`,
        status: 'started',
        seconds_in_flight: 12,
        ack_deadline_at: '2026-08-23T10:30:00.000Z',
      }];
    }
  }
  for (let i = 0; i < 9; i += 1) agents.push(agente({ alias: `libre-${i}` }));
  return {
    observed_at: OBSERVADO,
    thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
    agents,
  };
}

/** Los pares «número + palabra» de la línea de apoyo, tal y como se leen en pantalla. */
function cifrasDelApoyo(apoyo: string): Array<{ numero: number; palabra: string }> {
  return [...apoyo.matchAll(/(\d+)\s+([^·.]+)/g)].map((coincidencia) => ({
    numero: Number(coincidencia[1]),
    palabra: coincidencia[2].trim().toLowerCase(),
  }));
}

/** «libres» → «libre». Sin esto, la coincidencia con el rótulo del chip se escaparía por la `s`. */
function singular(palabra: string): string {
  return palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
}

describe('el veredicto y los chips de /live hablan el mismo idioma', () => {
  it('ninguna palabra compartida con un chip lleva un número distinto al del chip', () => {
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const veredicto = fleetVerdict(views, { observedAt: OBSERVADO, nowMs: AHORA, staleAfterMs: 12_000 });

    // La flota reconstruida es la medida: si esto cambiara, la prueba dejaría de mirar el defecto.
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
            `el veredicto dice «${numero} ${palabra}» y el chip «${LIVE_STATE_META[estado].label} `
            + `${tally[estado]}»: misma palabra, números distintos`,
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
    // CONTROL POSITIVO. Si el arreglo hubiera sido «cambiar todas las palabras para que ninguna
    // coincida», esta comprobación se caería: perderíamos la única cifra del veredicto que el
    // operador puede contrastar de un vistazo contra la cinta.
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const veredicto = fleetVerdict(views, { observedAt: OBSERVADO, nowMs: AHORA, staleAfterMs: 12_000 });

    expect(veredicto.apoyo).toContain(`${tally.idle} libres`);
  });

  it('CONTROL NEGATIVO — con la palabra vieja, el guardia marca el desacuerdo', () => {
    /*
     * Se le da de comer al comprobador la línea EXACTA que producía el defecto medido. Un guardia
     * que no la marque estaría aprobando el fallo que vino a buscar.
     */
    const { views } = buildLiveViews(flotaDelDefecto(), {}, AHORA);
    const tally = stateTally(views);
    const apoyoViejo = '13 conectados · 4 trabajando · 9 libres.';

    const desacuerdos: string[] = [];
    for (const { numero, palabra } of cifrasDelApoyo(apoyoViejo)) {
      for (const estado of LIVE_STATES) {
        const rotulo = LIVE_STATE_META[estado].label.toLowerCase();
        if (singular(palabra) === singular(rotulo) && numero !== tally[estado as LiveState]) {
          desacuerdos.push(`${palabra}: ${numero} vs ${tally[estado]}`);
        }
      }
    }
    expect(desacuerdos).toEqual(['trabajando: 4 vs 2']);
  });
});

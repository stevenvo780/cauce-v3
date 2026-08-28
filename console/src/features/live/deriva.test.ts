import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, TopologySnapshot } from '../../api/types';
import type { LiveAgentView } from './agent-state';
import { derivaDelRegistro } from './deriva';

/**
 * La prueba EN LAS DOS DIRECCIONES del contador que prometía simetría y medía una sola.
 *
 * El control que importa no es que cada dirección cuente bien por separado: es el par de casos
 * cruzados. Un contador que sólo recorre las membresías pasa `sinRegistro` con nota y devuelve
 * `sinSala = 0` para SIEMPRE, incluidos los casos en que hay deriva de sobra. Por eso cada
 * dirección tiene su caso positivo y su caso negativo, y hay un caso con las dos a la vez.
 */

function vista(overrides: Partial<LiveAgentView> & { tenantId: string; alias: string }): LiveAgentView {
  const { tenantId, alias } = overrides;
  const agent = {
    tenant_id: tenantId,
    alias,
    registered: true,
    ...(overrides.agent ?? {}),
  } as FleetActivityAgent;
  return {
    state: 'idle',
    reason: '',
    overloaded: false,
    inFlight: 0,
    queued: 0,
    delegatesTo: [],
    delegatedFrom: [],
    flags: [],
    rooms: [],
    origenes: [],
    ...overrides,
    // Los tres van DESPUÉS del spread a propósito: la clave se deriva del par y no se pasa suelta,
    // así ninguna prueba puede describir un alias con una `key` que no le corresponde.
    key: `${tenantId}/${alias}`,
    tenantId,
    alias,
    agent,
  };
}

function topologia(
  miembros: { tenant: string; alias: string; enabled?: boolean }[],
): TopologySnapshot {
  const porTenant = new Map<string, { alias: string; enabled?: boolean }[]>();
  for (const miembro of miembros) {
    porTenant.set(miembro.tenant, [
      ...(porTenant.get(miembro.tenant) ?? []),
      { alias: miembro.alias, enabled: miembro.enabled },
    ]);
  }
  return {
    tenants: [...porTenant].map(([id, members]) => ({
      id,
      rooms: [{ id: `grp.${id}`, members }],
    })),
  };
}

describe('membresía habilitada sin fila en el registro — el caso quota-collector', () => {
  it('la cuenta', () => {
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Steven', alias: 'kant' })],
      topologia([
        { tenant: 'Steven', alias: 'kant' },
        { tenant: 'Steven', alias: 'quota-collector' },
      ]),
    );
    expect(deriva.sinRegistro).toBe(1);
    expect(deriva.sinSala).toBe(0);
    expect(deriva.total).toBe(1);
  });

  it('NO cuenta una membresía deshabilitada: eso es una baja que alguien dio a propósito', () => {
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Steven', alias: 'kant' })],
      topologia([
        { tenant: 'Steven', alias: 'kant' },
        { tenant: 'Steven', alias: 'retirado', enabled: false },
      ]),
    );
    expect(deriva.sinRegistro).toBe(0);
    expect(deriva.total).toBe(0);
  });

  it('un participante que entró por una entrega abierta NO cuenta como registro', () => {
    // El universo de la actividad es `agents ∪ entregas-abiertas ∪ connection_leases`. Un alias
    // que aparece por una entrega y NO tiene fila en `agents` sigue estando fuera del registro, y
    // su membresía sigue siendo deriva aunque el muñeco esté dibujado. Si esto se midiera contra
    // «está en views» en vez de contra el registro, este caso daría 0 y el chip mentiría.
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Steven', alias: 'intruso', flags: ['unregistered'] })],
      topologia([{ tenant: 'Steven', alias: 'intruso' }]),
    );
    expect(deriva.sinRegistro).toBe(1);
  });
});

describe('alias del registro sin una sola membresía habilitada — el caso gaia', () => {
  /**
   * ÉSTA es la dirección que valía cero siempre. Con el contador anterior —el bucle que sólo
   * recorría las membresías— este test daba `0` y el chip no aparecía: `gaia` se dio de alta en
   * `agents`, se quedó sin sala y la pantalla que existe para mostrar la flota no decía nada.
   */
  it('la cuenta', () => {
    const deriva = derivaDelRegistro(
      [
        vista({ tenantId: 'Miguel', alias: 'atlas' }),
        vista({ tenantId: 'Miguel', alias: 'gaia' }),
      ],
      topologia([{ tenant: 'Miguel', alias: 'atlas' }]),
    );
    expect(deriva.sinSala).toBe(1);
    expect(deriva.sinRegistro).toBe(0);
    expect(deriva.total).toBe(1);
  });

  it('una membresía DESHABILITADA no salva al alias: media alta sigue siendo media alta', () => {
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Miguel', alias: 'gaia' })],
      topologia([{ tenant: 'Miguel', alias: 'gaia', enabled: false }]),
    );
    expect(deriva.sinSala).toBe(1);
  });

  it('con su membresía habilitada NO cuenta: es un alta completa', () => {
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Miguel', alias: 'gaia' })],
      topologia([{ tenant: 'Miguel', alias: 'gaia' }]),
    );
    expect(deriva.sinSala).toBe(0);
    expect(deriva.total).toBe(0);
  });

  it('un participante SIN registro y sin sala no cuenta: no hay alta a medias que denunciar', () => {
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Miguel', alias: 'fantasma', flags: ['unregistered'] })],
      topologia([]),
    );
    expect(deriva).toEqual({ sinRegistro: 0, sinSala: 0, total: 0 });
  });
});

describe('la simetría, que es lo que el comentario prometía y el código no hacía', () => {
  it('con deriva en las dos direcciones a la vez, cuenta las dos', () => {
    const deriva = derivaDelRegistro(
      [
        vista({ tenantId: 'Miguel', alias: 'atlas' }),
        vista({ tenantId: 'Miguel', alias: 'gaia' }),
      ],
      topologia([
        { tenant: 'Miguel', alias: 'atlas' },
        { tenant: 'Miguel', alias: 'quota-collector' },
      ]),
    );
    expect(deriva).toEqual({ sinRegistro: 1, sinSala: 1, total: 2 });
  });

  it('sin topología leída, el registro entero es deriva y no se inventa el otro lado', () => {
    // Una lectura que no llegó no es una flota sin salas; pero tampoco se puede afirmar lo
    // contrario. Lo que NO puede pasar es que `sinRegistro` invente membresías inexistentes.
    const deriva = derivaDelRegistro([vista({ tenantId: 'Miguel', alias: 'atlas' })], undefined);
    expect(deriva).toEqual({ sinRegistro: 0, sinSala: 1, total: 1 });
  });

  it('flota y salas en correspondencia exacta: cero por los dos lados', () => {
    const deriva = derivaDelRegistro(
      [
        vista({ tenantId: 'Steven', alias: 'kant' }),
        vista({ tenantId: 'Miguel', alias: 'atlas' }),
      ],
      topologia([
        { tenant: 'Steven', alias: 'kant' },
        { tenant: 'Miguel', alias: 'atlas' },
      ]),
    );
    expect(deriva).toEqual({ sinRegistro: 0, sinSala: 0, total: 0 });
  });
});

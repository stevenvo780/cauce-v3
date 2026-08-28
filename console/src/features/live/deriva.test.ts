import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, TopologySnapshot } from '../../api/types';
import type { LiveAgentView } from './agent-state';
import { derivaDelRegistro } from './deriva';

/**
 * The BOTH-DIRECTIONS test of the counter that promised symmetry and measured only one.
 *
 * The check that matters is not each direction counting correctly on its own: it is the pair of
 * crossed cases. A counter that only walks memberships passes `sinRegistro` with note and
 * returns `sinSala = 0` FOREVER, including cases with derivation to spare. That is why each
 * direction has its positive and its negative case, and there is one case with both at once.
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
    // The three are AFTER the spread on purpose: the key is derived from the pair and is not
    // passed loose, so no test can describe an alias with a `key` that does not match.
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
    // The activity universe is `agents ∪ open-deliveries ∪ connection_leases`. An alias that
    // appears through a delivery and has NO row in `agents` is still outside the registry, and
    // its membership is still derivation even though the bot is drawn. If this were measured
    // against "is in views" instead of against the registry, this case would return 0 and the
    // chip would lie.
    const deriva = derivaDelRegistro(
      [vista({ tenantId: 'Steven', alias: 'intruso', flags: ['unregistered'] })],
      topologia([{ tenant: 'Steven', alias: 'intruso' }]),
    );
    expect(deriva.sinRegistro).toBe(1);
  });
});

describe('alias del registro sin una sola membresía habilitada — el caso gaia', () => {
  /**
   * THIS is the direction that was always zero. With the previous counter — the loop that only
   * walked memberships — this test returned `0` and the chip did not show: one alias was
   * registered in `agents`, ended up without a room, and the screen that exists to show the
   * fleet said nothing.
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
    // A reading that did not arrive is not a fleet without rooms; but neither can the opposite
    // be asserted. What CANNOT happen is that `sinRegistro` invents non-existent memberships.
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

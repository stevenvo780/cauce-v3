import { describe, expect, it } from 'vitest';
import type { FleetActivitySnapshot, MessagePage, SystemStatus, TopologySnapshot } from '../../api/types';
import { aliasDeLosMensajes, construirRosterDeMensajeria, fueraDeLaTopologia, motivoDeAgenteSuelto } from './roster';

const enElFuturo = new Date(Date.now() + 60_000).toISOString();

/** Topología mínima: UNA sala con UN miembro. `gaia` no está por ningún lado. */
function topologiaConSoloArgos(): TopologySnapshot {
  return {
    tenants: [{
      id: 'Steven',
      rooms: [{ id: 'grp.steven', members: [{ alias: 'argos', enabled: true }] }],
    }],
  };
}

function presenciaDeArgos(): SystemStatus {
  return { presence: [{ tenant_id: 'Steven', alias: 'argos', epoch: 3, lease_expires_at: enElFuturo }] };
}

/** Un mensaje del operador `kant` con UNA entrega para `Steven:gaia`. */
function mensajeParaGaia(): MessagePage {
  return {
    items: [{
      message_id: 'msg-gaia', trace_id: 'trace-gaia-0001', tenant_id: 'Steven', room_id: 'grp.steven',
      actor_alias: 'kant', body_preview: 'gaia, tomá este encargo', lane: 'batch', created_at: enElFuturo,
      deliveries: [{ delivery_id: 'del-gaia', recipient_tenant: 'Steven', recipient_alias: 'gaia', status: 'pending', attempt: 1 }],
    }],
  };
}

describe('el universo del roster de mensajería', () => {
  it('incluye a un alias del REGISTRO que no tiene membresía ni lease: es el caso gaia', () => {
    const activity: FleetActivitySnapshot = {
      agents: [{ tenant_id: 'Steven', alias: 'gaia', registered: true, agent_enabled: true }],
    };
    const roster = construirRosterDeMensajeria({
      status: presenciaDeArgos(), topology: topologiaConSoloArgos(), activity,
    });

    const gaia = roster.find((agente) => agente.alias === 'gaia');
    expect(gaia).toBeDefined();
    expect(gaia?.origenes).toEqual(['registro']);
    expect(gaia?.registrado).toBe(true);
    expect(fueraDeLaTopologia(gaia!)).toBe(true);
    expect(motivoDeAgenteSuelto(gaia!)).toMatch(/registro de agentes y en NINGUNA sala/i);
    // Y no se le inventa un lease: sin presencia, el estado es UNKNOWN, nunca «online».
    expect(gaia?.leaseState).toBe('unknown');
  });

  it('un hilo con mensajes tiene fila aunque NI el registro conozca al alias', () => {
    const roster = construirRosterDeMensajeria({
      status: presenciaDeArgos(),
      topology: topologiaConSoloArgos(),
      activity: { agents: [] },
      messages: mensajeParaGaia(),
    });

    const gaia = roster.find((agente) => agente.alias === 'gaia');
    expect(gaia).toBeDefined();
    expect(gaia?.origenes).toEqual(['mensajes']);
    expect(gaia?.mensajesVisibles).toBe(1);
    expect(motivoDeAgenteSuelto(gaia!)).toMatch(/sólo porque el servidor publicó mensajes suyos/i);
  });

  it('también trae al EMISOR del mensaje, no sólo al destinatario', () => {
    const roster = construirRosterDeMensajeria({
      topology: topologiaConSoloArgos(), messages: mensajeParaGaia(),
    });
    expect(roster.map((agente) => agente.alias).sort()).toEqual(['argos', 'gaia', 'kant']);
  });

  it('copia la presencia que /activity publica en vez de fabricar una', () => {
    const activity: FleetActivitySnapshot = {
      agents: [{
        tenant_id: 'Steven', alias: 'gaia', registered: true,
        presence: { online: true, instance_id: 'gaia-1', epoch: 9, lease_until: enElFuturo },
      }],
    };
    const gaia = construirRosterDeMensajeria({ activity }).find((agente) => agente.alias === 'gaia');
    expect(gaia?.leaseState).toBe('online');
    expect(gaia?.presence?.epoch).toBe(9);
    expect(gaia?.presence?.tenant_id).toBe('Steven');
  });

  /**
   * CONTROL NEGATIVO. El arreglo consiste en AMPLIAR el universo, y un arreglo así se equivoca en
   * la dirección contraria: dibujando a cualquiera. Este caso exige que un alias que ninguna de
   * las cuatro fuentes menciona siga sin existir, y que la membresía deshabilitada no se convierta
   * en una afirmación de que sí se le puede escribir.
   */
  it('NO inventa un alias que ninguna de las cuatro fuentes menciona', () => {
    const roster = construirRosterDeMensajeria({
      status: presenciaDeArgos(),
      topology: topologiaConSoloArgos(),
      activity: { agents: [{ tenant_id: 'Steven', alias: 'gaia', registered: true }] },
      messages: mensajeParaGaia(),
    });
    expect(roster.some((agente) => agente.alias === 'fantasma')).toBe(false);
    expect(roster.map((agente) => agente.alias).sort()).toEqual(['argos', 'gaia', 'kant']);
  });

  it('un alias que sí está en una sala NO se rotula como suelto', () => {
    const roster = construirRosterDeMensajeria({
      status: presenciaDeArgos(), topology: topologiaConSoloArgos(),
    });
    const argos = roster.find((agente) => agente.alias === 'argos');
    expect(fueraDeLaTopologia(argos!)).toBe(false);
    expect(motivoDeAgenteSuelto(argos!)).toBeUndefined();
    expect(argos?.origenes).toEqual(['topologia', 'presencia']);
  });

  it('no duplica al alias que aparece en las cuatro fuentes a la vez', () => {
    const roster = construirRosterDeMensajeria({
      status: presenciaDeArgos(),
      topology: topologiaConSoloArgos(),
      activity: { agents: [{ tenant_id: 'Steven', alias: 'argos', registered: true }] },
      messages: {
        items: [{
          message_id: 'm1', tenant_id: 'Steven', actor_alias: 'argos',
          deliveries: [{ delivery_id: 'd1', recipient_tenant: 'Steven', recipient_alias: 'argos' }],
        }],
      },
    });
    expect(roster.filter((agente) => agente.alias === 'argos')).toHaveLength(1);
    expect(roster.find((agente) => agente.alias === 'argos')?.origenes)
      .toEqual(['topologia', 'presencia', 'registro', 'mensajes']);
  });
});

describe('aliasDeLosMensajes', () => {
  it('cuenta los dos extremos y descarta los campos vacíos sin romperse', () => {
    const encontrados = aliasDeLosMensajes({
      items: [
        { message_id: 'a', tenant_id: 'Steven', actor_alias: 'kant', deliveries: [{ recipient_tenant: 'Steven', recipient_alias: 'gaia' }] },
        { message_id: 'b', tenant_id: 'Steven', actor_alias: null, deliveries: [{ recipient_tenant: '  ', recipient_alias: 'gaia' }] },
        { message_id: 'c', tenant_id: 'Steven', actor_alias: 'kant', deliveries: null },
      ],
    });
    expect([...encontrados.keys()].sort()).toEqual(['steven:gaia', 'steven:kant']);
    expect(encontrados.get('steven:kant')?.mensajes).toBe(2);
    expect(encontrados.get('steven:gaia')?.mensajes).toBe(1);
  });

  it('sin página devuelve un mapa vacío, no una excepción', () => {
    expect(aliasDeLosMensajes(undefined).size).toBe(0);
  });
});

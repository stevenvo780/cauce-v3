import type { FleetActivitySnapshot, MessagePage, PresenceLease, SystemStatus, TopologySnapshot } from '../../api/types';
import { leaseExpiry, leaseState } from '../../lib';
import { buildFleetAgents, fleetAgentId, type FleetAgent } from '../terminal/fleet';

/**
 * WHERE each row of the roster came from. It's kept per agent because the screen has to be able
 * to say it: "this alias is in the registry but in no room" is an operational fact, and hiding it
 * was exactly the bug that cost the day of `gaia`.
 */
type OrigenDeAgente = 'topologia' | 'presencia' | 'registro' | 'mensajes';

export interface AgenteDeMensajeria extends FleetAgent {
  origenes: OrigenDeAgente[];
  /** Messages from the server's window where the alias is sender or recipient. */
  mensajesVisibles: number;
  /**
   * `GET /v3/console/activity` → `registered`. `undefined` = the server doesn't report it, which
   * is NOT the same as "not in the registry".
   */
  registrado?: boolean;
}

/**
 * Builds the messaging roster aggregating the four sources:
 * topology (memberships), presence, activity registry, and observed messages.
 */
export function construirRosterDeMensajeria(entrada: {
  status?: SystemStatus;
  topology?: TopologySnapshot;
  activity?: FleetActivitySnapshot;
  messages?: MessagePage;
}): AgenteDeMensajeria[] {
  const registros = new Map<string, AgenteDeMensajeria>();

  for (const agente of buildFleetAgents(entrada.status, entrada.topology)) {
    const origenes: OrigenDeAgente[] = [];
    if (agente.roomIds.length > 0) origenes.push('topologia');
    if (agente.presence) origenes.push('presencia');
    registros.set(agente.id, { ...agente, origenes, mensajesVisibles: 0 });
  }

  for (const fila of entrada.activity?.agents ?? []) {
    if (!fila.tenant_id || !fila.alias) continue;
    const id = fleetAgentId(fila.tenant_id, fila.alias);
    const existente = registros.get(id);
    if (existente) {
      registros.set(id, {
        ...existente,
        origenes: sumarOrigen(existente.origenes, 'registro'),
        registrado: typeof fila.registered === 'boolean' ? fila.registered : existente.registrado,
      });
      continue;
    }
    // The presence from `/activity` is the SAME one from the server, read by another endpoint:
    // it's copied, not fabricated. If it doesn't come, the alias stays in UNKNOWN lease, which is the truth.
    const presence: PresenceLease | undefined = fila.presence
      ? { ...fila.presence, tenant_id: fila.tenant_id, alias: fila.alias }
      : undefined;
    registros.set(id, {
      id,
      tenantId: fila.tenant_id,
      alias: fila.alias,
      roomIds: [],
      roomMembership: {},
      membershipEnabled: undefined,
      presence,
      leaseState: leaseState(leaseExpiry(presence ?? {})),
      origenes: ['registro'],
      mensajesVisibles: 0,
      registrado: typeof fila.registered === 'boolean' ? fila.registered : undefined,
    });
  }

  for (const [id, quien] of aliasDeLosMensajes(entrada.messages)) {
    const existente = registros.get(id);
    if (existente) {
      registros.set(id, {
        ...existente,
        origenes: sumarOrigen(existente.origenes, 'mensajes'),
        mensajesVisibles: quien.mensajes,
      });
      continue;
    }
    registros.set(id, {
      id,
      tenantId: quien.tenantId,
      alias: quien.alias,
      roomIds: [],
      roomMembership: {},
      membershipEnabled: undefined,
      presence: undefined,
      leaseState: 'unknown',
      origenes: ['mensajes'],
      mensajesVisibles: quien.mensajes,
    });
  }

  return [...registros.values()].sort((izquierda, derecha) => {
    const rango = { online: 0, unknown: 1, expired: 2 };
    return rango[izquierda.leaseState] - rango[derecha.leaseState]
      || izquierda.tenantId.localeCompare(derecha.tenantId)
      || izquierda.alias.localeCompare(derecha.alias);
  });
}

/**
 * An alias with history but one the console can't just write to: neither room nor registry
 * confirming it. The row is still drawn and labeled; what's NOT done is hiding it.
 */
export function fueraDeLaTopologia(agente: AgenteDeMensajeria): boolean {
  return agente.roomIds.length === 0;
}

/** What to say in the row when the alias doesn't live in any declared room. */
export function motivoDeAgenteSuelto(agente: AgenteDeMensajeria): string | undefined {
  if (!fueraDeLaTopologia(agente)) return undefined;
  if (agente.registrado === false) {
    return 'Sin sala y fuera del registro de agentes: apareció por entregas o por lease. Se muestra porque tiene historia, no porque el servidor lo declare agente.';
  }
  if (agente.origenes.includes('registro')) {
    return 'Está en el registro de agentes y en NINGUNA sala. Los mensajes se leen igual; para escribirle hace falta una membresía habilitada.';
  }
  return 'Ni sala, ni lease, ni registro: este alias existe acá sólo porque el servidor publicó mensajes suyos. El hilo no se esconde por eso.';
}

function sumarOrigen(origenes: OrigenDeAgente[], nuevo: OrigenDeAgente): OrigenDeAgente[] {
  return origenes.includes(nuevo) ? origenes : [...origenes, nuevo];
}

interface AliasConMensajes {
  tenantId: string;
  alias: string;
  mensajes: number;
}

/**
 * The two endpoints of each visible message: the sender (`tenant_id` + `actor_alias`) and each
 * recipient (`recipient_tenant` + `recipient_alias`). It is EXACTLY the same pair that
 * `transcriptForSession` uses to decide whether a message belongs to a thread, so no message
 * can end up without a row to land on.
 */
export function aliasDeLosMensajes(page: MessagePage | undefined): Map<string, AliasConMensajes> {
  const encontrados = new Map<string, AliasConMensajes>();

  function anotar(tenantId: unknown, alias: unknown) {
    if (typeof tenantId !== 'string' || !tenantId.trim()) return;
    if (typeof alias !== 'string' || !alias.trim()) return;
    const id = fleetAgentId(tenantId, alias);
    const actual = encontrados.get(id);
    encontrados.set(id, {
      tenantId: tenantId.trim(),
      alias: alias.trim(),
      mensajes: (actual?.mensajes ?? 0) + 1,
    });
  }

  for (const mensaje of page?.items ?? []) {
    anotar(mensaje.tenant_id, mensaje.actor_alias);
    for (const entrega of mensaje.deliveries ?? []) {
      anotar(entrega.recipient_tenant, entrega.recipient_alias);
    }
  }

  return encontrados;
}

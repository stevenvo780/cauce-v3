import type { FleetActivitySnapshot, MessagePage, PresenceLease, SystemStatus, TopologySnapshot } from '../../api/types';
import { leaseExpiry, leaseState } from '../../lib';
import { buildFleetAgents, fleetAgentId, type FleetAgent } from '../terminal/fleet';

/**
 * De DÓNDE salió cada fila del roster. Se guarda por agente porque la pantalla tiene que poder
 * decirlo: «este alias está en el registro pero en ninguna sala» es un dato operativo, y
 * esconderlo fue exactamente el defecto que costó el día de `gaia`.
 */
export type OrigenDeAgente = 'topologia' | 'presencia' | 'registro' | 'mensajes';

export interface AgenteDeMensajeria extends FleetAgent {
  origenes: OrigenDeAgente[];
  /** Mensajes de la ventana del servidor donde el alias es emisor o destinatario. */
  mensajesVisibles: number;
  /**
   * `GET /v3/console/activity` → `registered`. `undefined` = el servidor no lo informa, que NO
   * es lo mismo que «no está en el registro».
   */
  registrado?: boolean;
}

/**
 * EL UNIVERSO DEL ROSTER NO SON LAS MEMBRESÍAS.
 *
 * Antes esta vista tenía UNA sola fuente de agentes, `buildFleetAgents(status, topology)`, que es
 * `memberships ∪ presence`. Los dos consumidores de `listMessages()` —el roster y
 * `transcriptForSession`— se apoyaban en ella, así que un mensaje dirigido a un alias que la
 * topología no declara y que no tiene lease vigente no aparecía en NINGUNA parte de `/messages`:
 * ni fila, ni hilo, ni aviso. Ningún error, ninguna cifra en cero, ninguna forma de notarlo desde
 * la pantalla.
 *
 * Es el mismo fallo que hizo desaparecer a `gaia` del mapa de flota: se la dio de alta en la
 * tabla `agents` y la vista se dibujaba desde `memberships`, así que la pantalla que tenía que
 * mostrarla no la mostraba mientras el operador la miraba fijo. La corrección de aquella vista
 * (ver `features/live/LiveFleetPage.tsx`) fue dibujar desde el participante que reporta actividad
 * y dejar la membresía sólo para decidir el recuadro. Acá va la misma regla, con un añadido que
 * esta pantalla sí puede afirmar por su cuenta:
 *
 *   **un hilo con mensajes NUNCA desaparece.** Si el servidor publicó un mensaje hacia o desde un
 *   alias, ese alias tiene fila en el roster aunque no esté en ninguna sala, no tenga lease y el
 *   registro no lo conozca. La membresía decide si se le PUEDE ESCRIBIR —eso lo resuelve
 *   `operatorRouteForAgent`, que bloquea con su motivo—, nunca si se le puede LEER.
 *
 * Las cuatro fuentes, y qué aporta cada una:
 *
 *   - `topology`  (`memberships`) → salas y estado de membresía. Sigue siendo quien decide si hay
 *     room de origen para publicar.
 *   - `status.presence`            → lease e instancia observadas.
 *   - `activity.agents`            → el REGISTRO (`agents ∪ entregas abiertas ∪ leases`). Es la
 *     fuente que faltaba, y la que contiene a los `gaia`.
 *   - `messages`                   → el último recurso, y el que hace la promesa indestructible:
 *     con el registro caído o incompleto, un hilo con historia sigue teniendo fila.
 *
 * No se inventa nadie: un alias que no aparece en ninguna de las cuatro no se dibuja.
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
    // La presencia de `/activity` es la MISMA del servidor, leída por otro endpoint: se copia,
    // no se fabrica. Si no viene, el alias queda en lease UNKNOWN, que es la verdad.
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
 * Un alias del que hay historia pero al que la consola no le puede escribir sin más: ni sala, ni
 * registro que lo confirme. La fila se dibuja igual y se rotula; lo que NO se hace es esconderla.
 */
export function fueraDeLaTopologia(agente: AgenteDeMensajeria): boolean {
  return agente.roomIds.length === 0;
}

/** Qué decir en la fila cuando el alias no vive en ninguna sala declarada. */
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
 * Los dos extremos de cada mensaje visible: el emisor (`tenant_id` + `actor_alias`) y cada
 * destinatario (`recipient_tenant` + `recipient_alias`). Es EXACTAMENTE el mismo par que
 * `transcriptForSession` usa para decidir si un mensaje pertenece a un hilo, así que ningún
 * mensaje puede quedar sin fila donde caer.
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

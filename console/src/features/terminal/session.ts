import type { ConsoleAccess, DeliveryView, MessagePage, MessageView, TopologySnapshot } from '../../api/types';
import type { FleetAgent } from './fleet';

export interface OperatorSession {
  id: string;
  agent: FleetAgent;
  /** Room owned by the authenticated operator; it is never inferred from the recipient. */
  sourceRoomId: string;
  openedAt: string;
  mode: 'transcript' | 'pty';
  /** Canal PTY pedido para esta pestaña: `harness` es la TUI viva, `shell` es una shell nueva. */
  channelMode?: string;
  /** La apertura automática de la TUI se intenta UNA vez por pestaña; un 403 no se reintenta en bucle. */
  liveTuiAttempted?: boolean;
}

export interface OperatorRoute {
  allowed: boolean;
  sourceRoomIds: string[];
  membership: boolean | undefined;
  reason: string;
}

export interface TranscriptItem {
  message: MessageView;
  direction: 'input' | 'output';
  delivery?: DeliveryView;
}

function same(value: string | null | undefined, expected: string): boolean {
  // Both TenantSchema and the tenant-qualified API are case-sensitive. Case-folding identities
  // here mixed topology, ACL and transcript rows belonging to distinct tenants.
  return value === expected;
}

function actorIdentity(access: ConsoleAccess | undefined): { tenantId: string; alias: string } | undefined {
  if (typeof access?.subject !== 'string') return undefined;
  const parts = access.subject.split(':');
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return undefined;
  return { tenantId: parts[0].trim(), alias: parts[1].trim() };
}

function membershipSummary(states: (boolean | null | undefined)[]): boolean | undefined {
  if (states.length === 0) return undefined;
  if (states.some((state) => state === true)) return true;
  if (states.some((state) => state === undefined || state === null)) return undefined;
  return false;
}

/**
 * Resolves publish authority from the actor-scoped /topology/access snapshot.
 * Same-tenant targets require a shared room; cross-tenant targets require a
 * directed route/control ACL while the source remains one of the actor's rooms.
 */
export function operatorRouteForAgent(
  topology: TopologySnapshot | undefined,
  access: ConsoleAccess | undefined,
  agent: FleetAgent,
): OperatorRoute {
  const actor = actorIdentity(access);
  if (!actor) return { allowed: false, sourceRoomIds: [], membership: undefined, reason: 'No se pudo leer tu identidad de operador, así que no hay de dónde derivar un room de origen.' };

  const actorTenant = (topology?.tenants ?? []).find((tenant) => same(tenant.id, actor.tenantId));
  if (!actorTenant) return { allowed: false, sourceRoomIds: [], membership: undefined, reason: 'No se pudo leer la topología de tu cliente, así que no se sabe a qué salas pertenecés.' };

  const sameTenant = same(actor.tenantId, agent.tenantId);
  if (!sameTenant) {
    const recipientTenant = (topology?.tenants ?? []).find((tenant) => same(tenant.id, agent.tenantId));
    const recipientStates = (recipientTenant?.rooms ?? []).flatMap((room) => (
      (room.members ?? []).filter((member) => same(member.alias, agent.alias)).map((member) => member.enabled)
    ));
    const recipientMembership = membershipSummary(recipientStates);
    if (recipientMembership !== true) {
      return {
        allowed: false,
        sourceRoomIds: [],
        membership: recipientMembership,
        reason: recipientMembership === undefined
          ? 'No se pudo comprobar si el destinatario es miembro de una sala compartida con vos.'
          : 'El destinatario no tiene membership habilitada en su tenant.',
      };
    }
  }

  const candidateRooms = (actorTenant.rooms ?? []).flatMap((room) => {
    if (!room.id) return [];
    const actorMember = (room.members ?? []).find((member) => same(member.alias, actor.alias));
    if (!actorMember) return [];
    if (!sameTenant) return [{ id: room.id, enabled: actorMember.enabled }];
    const recipientMember = (room.members ?? []).find((member) => same(member.alias, agent.alias));
    if (!recipientMember) return [];
    const enabled = actorMember.enabled === true && recipientMember.enabled === true
      ? true
      : actorMember.enabled === false || recipientMember.enabled === false
        ? false
        : undefined;
    return [{ id: room.id, enabled }];
  });
  const sourceRoomIds = candidateRooms.filter((room) => room.enabled === true).map((room) => room.id).sort();
  const membership = membershipSummary(candidateRooms.map((room) => room.enabled));

  if (!sourceRoomIds.length) {
    const reason = membership === undefined
      ? 'No se pudo comprobar la membresía tuya o del destinatario; la publicación queda bloqueada.'
      : sameTenant
        ? 'El operador y el destinatario no comparten un room habilitado.'
        : 'El operador no pertenece a un room de origen habilitado en su tenant.';
    return { allowed: false, sourceRoomIds, membership, reason };
  }

  if (sameTenant) {
    return { allowed: true, sourceRoomIds, membership: true, reason: 'Room compartido y memberships verificadas.' };
  }

  const edge = (topology?.acl_edges ?? []).find((candidate) => (
    same(candidate.from_tenant, actor.tenantId) && same(candidate.to_tenant, agent.tenantId)
  ));
  if (edge?.enabled !== true || edge.allow_route !== true || edge.allow_control !== true) {
    return {
      allowed: false,
      sourceRoomIds,
      membership: true,
      reason: `ACL ${actor.tenantId} → ${agent.tenantId} no concede route + control; destino bloqueado.`,
    };
  }
  return { allowed: true, sourceRoomIds, membership: true, reason: 'Room de origen y ACL route + control verificados.' };
}

/** Projects authoritative server messages into a recipient-scoped, non-durable UI session. */
export function transcriptForSession(page: MessagePage | undefined, session: OperatorSession): TranscriptItem[] {
  return (page?.items ?? []).flatMap((message): TranscriptItem[] => {
    const output = same(message.tenant_id, session.agent.tenantId)
      && same(message.actor_alias, session.agent.alias);
    const delivery = (message.deliveries ?? []).find((candidate) => (
      same(candidate.recipient_tenant, session.agent.tenantId)
      && same(candidate.recipient_alias, session.agent.alias)
    ));
    if (!output && !delivery) return [];
    return [{ message, direction: output ? 'output' : 'input', delivery }];
  }).sort((left, right) => {
    const leftTime = Date.parse(left.message.created_at ?? '');
    const rightTime = Date.parse(right.message.created_at ?? '');
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return 0;
    return leftTime - rightTime;
  });
}

export function sessionDeliveries(items: TranscriptItem[]): DeliveryView[] {
  return items.flatMap((item) => item.delivery ? [item.delivery] : []);
}

/** A PTY grant is worthless without a written justification: it is what lands in the audit row. */
export const PTY_REASON_MIN_LENGTH = 8;
export const PTY_REASON_MAX_LENGTH = 280;

/**
 * Motivo de una observación de TUI en solo lectura.
 *
 * Mirar la pantalla que el agente ya está pintando no es lo mismo que abrirle una shell: no se
 * le pide al operador que escriba una justificación a mano para mirar. Pero la fila de auditoría
 * NO queda vacía ni mentida: dice exactamente qué se abrió, sobre quién, y que fue automático.
 * Una shell (`shell`) sigue exigiendo motivo escrito a mano, porque escribe.
 */
export function liveTuiReason(alias: string): string {
  return `Observacion automatica de la TUI en vivo de ${alias} (solo lectura) desde Ultimate Terminal.`;
}

/** Returns the operator-facing problem with a justification, or undefined when it is acceptable. */
export function ptyReasonProblem(reason: string): string | undefined {
  const text = reason.trim();
  if (text.length < PTY_REASON_MIN_LENGTH) {
    return `El motivo necesita al menos ${String(PTY_REASON_MIN_LENGTH)} caracteres (lleva ${String(text.length)}).`;
  }
  if (text.length > PTY_REASON_MAX_LENGTH) {
    return `El motivo no puede pasar de ${String(PTY_REASON_MAX_LENGTH)} caracteres (lleva ${String(text.length)}).`;
  }
  return undefined;
}

/** Whole seconds left on the grant. UNKNOWN expiry yields undefined, never a fake countdown. */
export function ptySecondsLeft(expiresAt: string | null | undefined, now = Date.now()): number | undefined {
  if (typeof expiresAt !== 'string' || !expiresAt.trim()) return undefined;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return undefined;
  return Math.max(0, Math.floor((expiry - now) / 1000));
}

export function formatCountdown(seconds: number | undefined): string {
  if (seconds === undefined) return 'sin dato';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

// La traducción de denegaciones PTY se centraliza en denegaciones.ts.


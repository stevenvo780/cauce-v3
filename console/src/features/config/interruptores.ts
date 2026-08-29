import type { ConfigMutation } from '../../api/types';
import { claveDeFila } from './collection-table';

/**
 * Pure specification of configuration toggles:
 * maps boolean collection fields to their inverse mutations and operational descriptions.
 */

export interface Interruptor {
  /** Identifies the toggle across the whole page: collection, row and field. */
  clave: string;
  coleccion: string;
  filaId: string;
  campo: string;
  /** What the toggle says now, according to the server's last good snapshot. */
  valor: boolean;
  /**
   * `aria-label` of the control. Names the row AND the permission: a screen reader that just
   * says "Route" twenty-four times does not let you tell which edge is being discussed.
   */
  aria: string;
  /** What is asserted when it is applied. Shown in the notice and in a rejection message. */
  descripcion: string;
  /** The mutation that flips the field to `!valor`. Partial on purpose: see the comment below. */
  mutation: ConfigMutation;
  /** Mandatory confirmation text, or `undefined` if none is required. */
  confirmar?: string;
}

/**
 * Which field of which collection is toggled, IN ORDER. Anything not listed here keeps being shown
 * as data —the "Yes"/"No" pill— and is edited through the mutation editor: a toggle that builds a
 * mutation the server will reject is worse than not offering the toggle.
 *
 * `is_hub` of a tenant is INTENTIONALLY absent even though it is boolean and the schema accepts
 * it: moving a fleet's hub is not a one-click operation, and putting it next to "Enabled" invites
 * doing it by accident.
 */
export const CAMPOS_CONMUTABLES: Record<string, readonly string[]> = {
  tenants: ['enabled'],
  rooms: ['enabled'],
  memberships: ['enabled'],
  acl_edges: ['enabled', 'allow_route', 'allow_read', 'allow_control'],
  role_policies: ['allow_route', 'allow_read', 'allow_control', 'allow_notify'],
};

export function esCampoConmutable(coleccion: string, campo: string): boolean {
  return (CAMPOS_CONMUTABLES[coleccion] ?? []).includes(campo);
}

/**
 * What each permission grants, in one short sentence in English. Goes into the column header's
 * tooltip: `allow_route` is the name of a Postgres column, not an explanation, and the operator
 * reaching this screen needs to know what they are turning on BEFORE turning it on.
 */
export const EXPLICACION_DE_CAMPO: Record<string, Record<string, string>> = {
  acl_edges: {
    enabled: 'El interruptor maestro del cruce. Apagado, los tres permisos de la derecha no cuentan: '
      + 'entre estos dos clientes no pasa nada.',
    allow_route: 'Deja que el cliente de la izquierda le MANDE mensajes a los agentes del de la '
      + 'derecha. Sin esto no hay entrega posible, ni siquiera para responder.',
    allow_read: 'Deja que el de la izquierda LEA la actividad del de la derecha: sus mensajes, sus '
      + 'entregas y sus colas.',
    allow_control: 'Deja que el de la izquierda ESCRIBA sobre el de la derecha: altas, permisos, '
      + 'reinyecciones y terminal. Es el permiso más fuerte de los cuatro.',
  },
  role_policies: {
    allow_route: 'Un agente con este rol puede publicar mensajes.',
    allow_read: 'Un agente con este rol puede leer la actividad de su cliente.',
    allow_control: 'Un agente con este rol puede escribir configuración y abrir terminales. Quitarlo '
      + 'de «operator» deja a la consola entera sin quien la administre.',
    allow_notify: 'Un agente con este rol puede escribirle a una conversación humana sin que nadie '
      + 'se lo haya preguntado.',
  },
  tenants: {
    enabled: 'Apagar un cliente lo saca del enrutado entero: sus agentes dejan de recibir entregas.',
  },
  rooms: {
    enabled: 'Apagar una sala corta las entregas que pasan por ella. Los miembros siguen existiendo.',
  },
  memberships: {
    enabled: 'De acá sale la flota que recibe entregas. Un alias con la membresía apagada no recibe '
      + 'nada, aunque esté en el registro de agentes.',
  },
};

export function explicacionDeCampo(coleccion: string, campo: string): string | undefined {
  const porColeccion = Object.hasOwn(EXPLICACION_DE_CAMPO, coleccion) ? EXPLICACION_DE_CAMPO[coleccion] : undefined;
  if (!porColeccion) return undefined;
  return Object.hasOwn(porColeccion, campo) ? porColeccion[campo] : undefined;
}

function texto(fila: Record<string, unknown>, campo: string): string | undefined {
  const valor = fila[campo];
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined;
}

/** How the row is named in one phrase. `undefined` if it lacks the identity needed to build the mutation. */
export function sujetoDeFila(coleccion: string, fila: Record<string, unknown>): string | undefined {
  if (coleccion === 'tenants') {
    const id = texto(fila, 'id');
    return id === undefined ? undefined : `el cliente ${id}`;
  }
  if (coleccion === 'rooms') {
    const tenantId = texto(fila, 'tenant_id');
    const id = texto(fila, 'id');
    return tenantId === undefined || id === undefined ? undefined : `la sala ${tenantId}/${id}`;
  }
  if (coleccion === 'memberships') {
    const tenantId = texto(fila, 'tenant_id');
    const roomId = texto(fila, 'room_id');
    const alias = texto(fila, 'alias');
    return tenantId === undefined || roomId === undefined || alias === undefined
      ? undefined
      : `la membresía ${tenantId}/${roomId}/${alias}`;
  }
  if (coleccion === 'acl_edges') {
    const desde = texto(fila, 'from_tenant');
    const hacia = texto(fila, 'to_tenant');
    return desde === undefined || hacia === undefined ? undefined : `la arista ${desde} → ${hacia}`;
  }
  if (coleccion === 'role_policies') {
    const rol = texto(fila, 'role');
    return rol === undefined ? undefined : `el rol ${rol}`;
  }
  return undefined;
}

/** Short permission name, for the `aria-label` and the notice. */
const NOMBRE_DE_CAMPO: Record<string, string> = {
  enabled: 'Habilitado', allow_route: 'Ruta', allow_read: 'Lectura',
  allow_control: 'Control', allow_notify: 'Aviso proactivo',
};

function nombreDeCampo(campo: string): string {
  return Object.hasOwn(NOMBRE_DE_CAMPO, campo) ? NOMBRE_DE_CAMPO[campo] : campo;
}

/**
 * The PARTIAL mutation that changes a single field. It being partial is not a shortcut: the store
 * field-by-field merges against the row read with `FOR UPDATE`
 * (`has(value,'enabled') ? value.enabled : old.enabled`), so sending only `allow_read` does not
 * overwrite the `allow_route` another operator just changed on the same edge.
 *
 * What the SEND is partial, the UNDO is not: the inverse stored in `config_revisions` carries the
 * ENTIRE row that existed before. The audit trail panel says so.
 */
function mutacion(
  coleccion: string, fila: Record<string, unknown>, campo: string, siguiente: boolean,
): ConfigMutation | undefined {
  const value = { [campo]: siguiente };
  if (coleccion === 'tenants') {
    const id = texto(fila, 'id');
    return id === undefined ? undefined : { resource: 'tenant', action: 'update', id, value };
  }
  if (coleccion === 'rooms') {
    const tenantId = texto(fila, 'tenant_id');
    const id = texto(fila, 'id');
    if (tenantId === undefined || id === undefined) return undefined;
    return { resource: 'room', action: 'update', tenant_id: tenantId, id, value };
  }
  if (coleccion === 'memberships') {
    const tenantId = texto(fila, 'tenant_id');
    const roomId = texto(fila, 'room_id');
    const alias = texto(fila, 'alias');
    if (tenantId === undefined || roomId === undefined || alias === undefined) return undefined;
    return { resource: 'membership', action: 'update', tenant_id: tenantId, room_id: roomId, alias, value };
  }
  if (coleccion === 'acl_edges') {
    const desde = texto(fila, 'from_tenant');
    const hacia = texto(fila, 'to_tenant');
    if (desde === undefined || hacia === undefined) return undefined;
    return { resource: 'acl_edge', action: 'update', from_tenant: desde, to_tenant: hacia, value };
  }
  if (coleccion === 'role_policies') {
    const rol = texto(fila, 'role');
    return rol === undefined ? undefined : { resource: 'role_policy', action: 'update', role: rol, value };
  }
  return undefined;
}

/**
 * Builds the confirmation message for critical actions (such as revoking allow_control).
 */
function confirmacion(campo: string, valor: boolean, sujeto: string): string | undefined {
  if (campo !== 'allow_control' || !valor) return undefined;
  return `Quitar Control en ${sujeto} deja sin poder escribir configuración, reinyectar entregas ni `
    + 'abrir terminales del otro lado. Si el permiso que estás quitando es el tuyo, no vas a poder '
    + 'devolvértelo desde acá: va a hacer falta otra identidad que todavía lo tenga.';
}

/**
 * The toggle for a row's field, or `undefined` if it cannot be built.
 *
 * Returns `undefined` —and the cell falls back to the read-only pill— in two cases, both on
 * purpose: when the value is not a boolean (you cannot write "the opposite" of something that is
 * not known) and when the row does not carry the identity fields the mutation needs. A toggle
 * that cannot write is worse than a datum that cannot be touched.
 */
export function interruptorDeFila(
  coleccion: string, fila: Record<string, unknown>, campo: string, indice: number,
): Interruptor | undefined {
  if (!esCampoConmutable(coleccion, campo)) return undefined;
  const valor = fila[campo];
  if (typeof valor !== 'boolean') return undefined;
  const sujeto = sujetoDeFila(coleccion, fila);
  if (sujeto === undefined) return undefined;
  const mutation = mutacion(coleccion, fila, campo, !valor);
  if (!mutation) return undefined;
  const filaId = claveDeFila(coleccion, fila, indice);
  const nombre = nombreDeCampo(campo);
  return {
    clave: `${coleccion}|${filaId}|${campo}`,
    coleccion,
    filaId,
    campo,
    valor,
    aria: `${nombre} en ${sujeto}`,
    descripcion: `${valor ? 'Quitar' : 'Conceder'} ${nombre} en ${sujeto}`,
    mutation,
    ...(() => {
      const aviso = confirmacion(campo, valor, sujeto);
      return aviso === undefined ? {} : { confirmar: aviso };
    })(),
  };
}

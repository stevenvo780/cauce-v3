import type { ConfigMutation } from '../../api/types';

/**
 * Onboarding of a config resource via a FORM, instead of forcing the operator to type the mutation
 * by hand in JSON.
 *
 * The four resources that get onboarded daily are covered —membership and acl_edge first, since
 * they are the most used, then tenant and room—. Everything else still has the raw editor below:
 * better four working forms than twelve half-baked ones.
 *
 * The validations are the SAME expressions as in `packages/protocol/src/schemas.ts`, copied on
 * purpose: here they only serve to keep the operator from being sent into a guaranteed 400. The
 * authority remains the gateway's zod plus `authorizeMutation`'s RBAC; this screen decides nothing.
 */

export type RecursoAlta = 'membership' | 'acl_edge' | 'tenant' | 'room';

export const RECURSOS_ALTA: readonly RecursoAlta[] = ['membership', 'acl_edge', 'tenant', 'room'];

export const TITULOS_ALTA: Record<RecursoAlta, string> = {
  membership: 'Membership (alias en una room)',
  acl_edge: 'Arista ACL (cruce entre tenants)',
  tenant: 'Tenant',
  room: 'Room',
};

// TenantSchema and AliasSchema from packages/protocol/src/schemas.ts.
const TENANT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

export interface BorradorAlta {
  tenantId: string;
  roomId: string;
  alias: string;
  role: string;
  habilitado: boolean;
  desde: string;
  hacia: string;
  allowRoute: boolean;
  allowRead: boolean;
  allowControl: boolean;
  nombre: string;
  esHub: boolean;
}

export const BORRADOR_VACIO: BorradorAlta = {
  tenantId: '', roomId: '', alias: '', role: 'agent', habilitado: true,
  desde: '', hacia: '', allowRoute: false, allowRead: false, allowControl: false,
  nombre: '', esHub: false,
};

/**
 * First reason the onboarding CANNOT be sent, or `undefined` if the draft passes. It returns
 * the reason rather than a boolean because a disabled button without an explanation leaves the
 * operator guessing which of the six fields is wrong.
 */
export function errorDeAlta(recurso: RecursoAlta, borrador: BorradorAlta): string | undefined {
  if (recurso === 'tenant') {
    return TENANT.test(borrador.tenantId.trim())
      ? undefined
      : 'El tenant debe empezar con letra y seguir con letras, números, guion o guion bajo (máx. 64).';
  }
  if (recurso === 'room') {
    if (!TENANT.test(borrador.tenantId.trim())) return 'El tenant debe empezar con letra (máx. 64 caracteres).';
    const room = borrador.roomId.trim();
    return room.length >= 1 && room.length <= 128 ? undefined : 'El room necesita un id de 1 a 128 caracteres.';
  }
  if (recurso === 'membership') {
    if (!TENANT.test(borrador.tenantId.trim())) return 'El tenant debe empezar con letra (máx. 64 caracteres).';
    const room = borrador.roomId.trim();
    if (room.length < 1 || room.length > 128) return 'El room necesita un id de 1 a 128 caracteres.';
    if (!SLUG.test(borrador.alias.trim())) {
      return 'El alias debe ser minúsculas, empezar con letra y usar sólo letras, números, guion o guion bajo.';
    }
    return SLUG.test(borrador.role.trim())
      ? undefined
      : 'El rol de permisos debe ser minúsculas y empezar con letra: route/read/control salen de role_policies y no cambian el contexto.';
  }
  if (!TENANT.test(borrador.desde.trim())) return 'El tenant de origen debe empezar con letra (máx. 64 caracteres).';
  if (!TENANT.test(borrador.hacia.trim())) return 'El tenant de destino debe empezar con letra (máx. 64 caracteres).';
  // The store rejects an edge to itself with a 409; warning here saves the round trip.
  return borrador.desde.trim() === borrador.hacia.trim()
    ? 'Una arista de un tenant hacia sí mismo está prohibida en el servidor: elegí dos tenants distintos.'
    : undefined;
}

/**
 * The exact mutation that will be sent. Shown on screen before applying: the operator must be
 * able to see what they sign, especially on ACL edges, where the default is DENY and a single
 * extra check opens a cross-tenant channel.
 */
export function mutacionDeAlta(recurso: RecursoAlta, borrador: BorradorAlta): ConfigMutation {
  const tenantId = borrador.tenantId.trim();
  const nombre = borrador.nombre.trim();
  if (recurso === 'tenant') {
    return {
      resource: 'tenant', action: 'create', id: tenantId,
      value: { display_name: nombre === '' ? null : nombre, is_hub: borrador.esHub, enabled: borrador.habilitado },
    };
  }
  if (recurso === 'room') {
    return {
      resource: 'room', action: 'create', tenant_id: tenantId, id: borrador.roomId.trim(),
      value: { display_name: nombre === '' ? null : nombre, enabled: borrador.habilitado },
    };
  }
  if (recurso === 'membership') {
    return {
      resource: 'membership', action: 'create', tenant_id: tenantId,
      room_id: borrador.roomId.trim(), alias: borrador.alias.trim(),
      value: { role: borrador.role.trim(), enabled: borrador.habilitado },
    };
  }
  return {
    resource: 'acl_edge', action: 'create',
    from_tenant: borrador.desde.trim(), to_tenant: borrador.hacia.trim(),
    value: {
      enabled: borrador.habilitado,
      allow_route: borrador.allowRoute,
      allow_read: borrador.allowRead,
      allow_control: borrador.allowControl,
    },
  };
}

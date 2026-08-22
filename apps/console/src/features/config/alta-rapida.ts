import type { ConfigMutation } from '../../api/types';

/**
 * Alta de un recurso de configuración con un FORMULARIO, en vez de obligar al operador a tipear la
 * mutación a mano en JSON.
 *
 * Se cubren los cuatro recursos que se dan de alta a diario —membership y acl_edge primero, que son
 * los que más se usan, y después tenant y room—. El resto sigue teniendo el editor crudo abajo:
 * mejor cuatro formularios que funcionen que doce a medias.
 *
 * Las validaciones son las MISMAS expresiones que `packages/protocol/src/schemas.ts`, copiadas a
 * propósito: acá sólo sirven para no mandar al operador a un 400 seguro. La autoridad sigue siendo
 * el zod del gateway más el RBAC de `authorizeMutation`; esta pantalla no decide nada.
 */

export type RecursoAlta = 'membership' | 'acl_edge' | 'tenant' | 'room';

export const RECURSOS_ALTA: readonly RecursoAlta[] = ['membership', 'acl_edge', 'tenant', 'room'];

export const TITULOS_ALTA: Record<RecursoAlta, string> = {
  membership: 'Membership (alias en una room)',
  acl_edge: 'Arista ACL (cruce entre tenants)',
  tenant: 'Tenant',
  room: 'Room',
};

// TenantSchema y AliasSchema de packages/protocol/src/schemas.ts.
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
 * Primer motivo por el que el alta NO se puede mandar, o `undefined` si el borrador pasa. Devuelve
 * el motivo y no un booleano porque un botón deshabilitado sin explicación deja al operador
 * adivinando cuál de los seis campos está mal.
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
      : 'El rol debe ser minúsculas y empezar con letra: los route/read/control salen de role_policies.';
  }
  if (!TENANT.test(borrador.desde.trim())) return 'El tenant de origen debe empezar con letra (máx. 64 caracteres).';
  if (!TENANT.test(borrador.hacia.trim())) return 'El tenant de destino debe empezar con letra (máx. 64 caracteres).';
  // El store rechaza la arista a sí mismo con un 409; avisarlo acá ahorra el viaje.
  return borrador.desde.trim() === borrador.hacia.trim()
    ? 'Una arista de un tenant hacia sí mismo está prohibida en el servidor: elegí dos tenants distintos.'
    : undefined;
}

/**
 * La mutación exacta que se va a enviar. Se muestra en pantalla antes de aplicar: el operador tiene
 * que poder ver lo que firma, sobre todo en las aristas ACL, donde el default es DENY y un tilde de
 * más abre un cruce entre tenants.
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

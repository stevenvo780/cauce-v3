import type { ConfigMutation } from '../../api/types';

/**
 * Cómo se dibuja cada colección del snapshot de configuración COMO TABLA, y qué mutación arma cada
 * botón de una fila.
 *
 * Está en un `.ts` aparte y no dentro del `.tsx` por dos razones: `react-refresh/only-export-components`
 * falla el lint (`--max-warnings 0`) en cuanto un fichero de componentes exporta algo que no es un
 * componente, y porque estas funciones son puras y se prueban sin montar React.
 *
 * Por qué existe: la vista pintaba `{"id":"Isa","display_name":null,...}` en un `<pre>` por fila y
 * la ÚNICA forma de escribir era tipear la mutación a mano en JSON. El backend ya sabía escribir
 * doce recursos; lo que faltaba era pantalla.
 */

/**
 * Orden de columnas de las colecciones que tienen forma conocida (el SELECT de
 * `packages/store/src/configuration.ts`). Para el resto se derivan de las filas: una colección que
 * el servidor agregue mañana igual se ve como tabla, con los nombres de campo del servidor.
 */
const COLUMNAS_FIJAS: Record<string, readonly string[]> = {
  tenants: ['id', 'display_name', 'is_hub', 'enabled', 'created_at'],
  rooms: ['tenant_id', 'id', 'display_name', 'enabled', 'created_at'],
  memberships: ['tenant_id', 'room_id', 'alias', 'role', 'enabled', 'created_at'],
  acl_edges: ['from_tenant', 'to_tenant', 'enabled', 'allow_route', 'allow_read', 'allow_control', 'created_at'],
};

/**
 * Traducción de los nombres de campo del servidor. Lo que NO está acá se muestra con el nombre
 * crudo del servidor a propósito: inventarle un título castellano a un campo que no conocemos sería
 * afirmar que sabemos qué significa.
 */
const ETIQUETAS: Record<string, string> = {
  id: 'Id', tenant_id: 'Tenant', room_id: 'Room', alias: 'Alias', role: 'Rol',
  display_name: 'Nombre', is_hub: 'Hub', enabled: 'Habilitado',
  created_at: 'Alta', updated_at: 'Última edición',
  from_tenant: 'Desde', to_tenant: 'Hacia',
  allow_route: 'allow_route', allow_read: 'allow_read', allow_control: 'allow_control',
  allow_notify: 'allow_notify', harness_id: 'Harness', command: 'Comando',
  capabilities: 'Capacidades', handle: 'Handle', adapter: 'Adaptador', channel: 'Canal',
  provider: 'Proveedor', account_id: 'Cuenta', agent_alias: 'Alias', priority: 'Prioridad',
  role_brief: 'Rol declarado', label: 'Etiqueta',
};

export interface ColumnaTabla {
  clave: string;
  etiqueta: string;
}

/** Campos que se formatean como fecha en vez de como texto plano. */
export function esColumnaDeFecha(clave: string): boolean {
  return clave === 'created_at' || clave === 'updated_at';
}

/**
 * Campos que traen un PÁRRAFO, no un dato. `role_brief` admite hasta 1200 caracteres en la base y
 * volcarlo entero en una celda empuja las otras once columnas de «Agent registry» fuera de la
 * pantalla: una fila deja de leerse por culpa de un campo que acá no se edita.
 *
 * El texto completo no se pierde: sigue en el `title` de la celda, en el desplegable «Ver crudo»
 * de la colección, y se EDITA en la pestaña «Rol» del cajón de «La flota ahora». Acá alcanza con
 * verlo resumido.
 */
const COLUMNAS_LARGAS: ReadonlySet<string> = new Set(['role_brief']);

export function esColumnaLarga(clave: string): boolean {
  return COLUMNAS_LARGAS.has(clave);
}

/** Cuántos caracteres de un campo largo entran en una celda antes de recortar. */
export const LARGO_DE_RESUMEN = 120;

/**
 * Recorte visible. El «…» final no es decorativo: es la única señal de que lo que se está leyendo
 * NO es el valor entero, y sin ella un brief cortado se confunde con un brief corto.
 *
 * Cuenta puntos de código (`[...texto]`) y no unidades UTF-16, igual que el contador de la pestaña
 * «Rol»: cortar por la mitad un emoji dejaría un carácter roto en pantalla.
 */
export function resumirTextoLargo(valor: string, largo: number = LARGO_DE_RESUMEN): string {
  const puntos = [...valor];
  return puntos.length <= largo ? valor : `${puntos.slice(0, largo).join('')}…`;
}

/**
 * Una columna sólo se dibuja si al menos una fila TRAE la clave. Un `created_at` que el gateway no
 * publica no debe aparecer como una columna entera de UNKNOWN: eso no es un dato faltante fila por
 * fila, es una columna que este servidor no tiene.
 */
export function columnasDe(clave: string, filas: ReadonlyArray<Record<string, unknown>>): ColumnaTabla[] {
  const fijas = COLUMNAS_FIJAS[clave] ?? [];
  const presentes = fijas.filter((campo) => filas.some((fila) => Object.hasOwn(fila, campo)));
  const extra: string[] = [];
  for (const fila of filas) {
    for (const campo of Object.keys(fila)) {
      if (!presentes.includes(campo) && !extra.includes(campo)) extra.push(campo);
    }
  }
  return [...presentes, ...extra].map((campo) => ({
    clave: campo,
    etiqueta: Object.hasOwn(ETIQUETAS, campo) ? ETIQUETAS[campo] : campo,
  }));
}

/** Campos que identifican una fila en cada colección, en el orden de la clave primaria. */
const IDENTIDAD: Record<string, readonly string[]> = {
  tenants: ['id'],
  rooms: ['tenant_id', 'id'],
  memberships: ['tenant_id', 'room_id', 'alias'],
  acl_edges: ['from_tenant', 'to_tenant'],
  harness_definitions: ['id'],
  role_policies: ['role'],
  chain_policies: ['id'],
  egress_destinations: ['tenant_id', 'alias', 'handle'],
  agents: ['tenant_id', 'alias'],
  provider_accounts: ['id'],
  alias_routing_ceiling: ['tenant_id', 'alias', 'account_id'],
  agent_account_bindings: ['tenant_id', 'agent_alias', 'account_id'],
};

/**
 * Clave de React de una fila. El índice es el último recurso y no el primero: reordenar la lista
 * con claves por índice reusa el estado del componente de OTRA fila, y acá cada fila tiene botones
 * que escriben en la base.
 */
export function claveDeFila(clave: string, fila: Record<string, unknown>, indice: number): string {
  const campos = IDENTIDAD[clave] ?? [];
  const partes = campos.map((campo) => texto(fila, campo)).filter((parte) => parte !== undefined);
  return partes.length === campos.length && partes.length > 0 ? partes.join('/') : `fila-${indice}`;
}

function texto(fila: Record<string, unknown>, campo: string): string | undefined {
  const valor = fila[campo];
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined;
}

function booleano(fila: Record<string, unknown>, campo: string): boolean | undefined {
  const valor = fila[campo];
  return typeof valor === 'boolean' ? valor : undefined;
}

export interface AccionDeFila {
  /** Estable dentro de la fila: identifica qué botón está esperando confirmación. */
  id: string;
  /** Texto del botón. */
  etiqueta: string;
  /** Frase completa; sirve de `aria-label` del botón y de encabezado de la confirmación. */
  descripcion: string;
  mutation: ConfigMutation;
}

/** Colecciones que tienen botones de un clic. El resto se ve, pero se edita por el editor crudo. */
export const COLECCIONES_CON_ACCIONES: ReadonlySet<string> = new Set([
  'tenants', 'rooms', 'memberships', 'acl_edges',
]);

/**
 * Las acciones frecuentes de una fila, ya con la mutación armada. Van por el MISMO
 * `api.changeConfiguration` que el editor crudo, así que quedan en `config_revisions` con su
 * inversa y se deshacen desde el audit trail.
 *
 * `update` con un `value` PARCIAL es lo correcto y no un atajo: el store hace merge campo por campo
 * contra la fila que leyó `FOR UPDATE` (`has(value,'enabled') ? ... : old.enabled`), así que mandar
 * sólo `enabled` no pisa el `role` que otro operador acaba de cambiar.
 *
 * Lo que el ENVÍO es parcial no lo es el DESHACER: la inversa que el store guarda en
 * `config_revisions` lleva como `oldValue` la fila ENTERA que había antes, no el campo que se tocó.
 * Deshacer esa revisión desde el audit trail restituye toda la fila, así que si dos operadores
 * tocaron campos distintos de la misma arista, deshacer el de A revierte también lo de B. Está
 * dicho en la interfaz —en el panel del audit trail— porque el operador no puede deducirlo de un
 * botón que dice «Rollback».
 *
 * Si `enabled` no viene como booleano no se ofrece el botón: no se puede escribir "el contrario"
 * de un valor que no se conoce. Es preferible una fila sin acciones a una que apague algo por
 * suponer que estaba encendido.
 */
export function accionesDeFila(clave: string, fila: Record<string, unknown>): AccionDeFila[] {
  if (clave === 'tenants') {
    const id = texto(fila, 'id');
    const habilitado = booleano(fila, 'enabled');
    if (id === undefined || habilitado === undefined) return [];
    return [alternar('enabled', habilitado, `el tenant ${id}`, {
      resource: 'tenant', action: 'update', id, value: { enabled: !habilitado },
    })];
  }
  if (clave === 'rooms') {
    const tenantId = texto(fila, 'tenant_id');
    const id = texto(fila, 'id');
    const habilitado = booleano(fila, 'enabled');
    if (tenantId === undefined || id === undefined || habilitado === undefined) return [];
    return [alternar('enabled', habilitado, `la room ${tenantId}/${id}`, {
      resource: 'room', action: 'update', tenant_id: tenantId, id, value: { enabled: !habilitado },
    })];
  }
  if (clave === 'memberships') {
    const tenantId = texto(fila, 'tenant_id');
    const roomId = texto(fila, 'room_id');
    const alias = texto(fila, 'alias');
    const habilitado = booleano(fila, 'enabled');
    if (tenantId === undefined || roomId === undefined || alias === undefined) return [];
    if (habilitado === undefined) return [];
    return [alternar('enabled', habilitado, `la membership ${tenantId}/${roomId}/${alias}`, {
      resource: 'membership', action: 'update', tenant_id: tenantId, room_id: roomId, alias,
      value: { enabled: !habilitado },
    })];
  }
  if (clave === 'acl_edges') {
    const desde = texto(fila, 'from_tenant');
    const hacia = texto(fila, 'to_tenant');
    if (desde === undefined || hacia === undefined) return [];
    const arista = `la arista ${desde} → ${hacia}`;
    const acciones: AccionDeFila[] = [];
    const habilitado = booleano(fila, 'enabled');
    if (habilitado !== undefined) {
      acciones.push(alternar('enabled', habilitado, arista, {
        resource: 'acl_edge', action: 'update', from_tenant: desde, to_tenant: hacia,
        value: { enabled: !habilitado },
      }));
    }
    for (const permiso of ['allow_route', 'allow_read', 'allow_control'] as const) {
      const actual = booleano(fila, permiso);
      if (actual === undefined) continue;
      acciones.push({
        id: permiso,
        etiqueta: `${actual ? 'Quitar' : 'Conceder'} ${permiso}`,
        descripcion: `${actual ? 'Quitar' : 'Conceder'} ${permiso} en ${arista}`,
        mutation: {
          resource: 'acl_edge', action: 'update', from_tenant: desde, to_tenant: hacia,
          value: { [permiso]: !actual },
        },
      });
    }
    return acciones;
  }
  return [];
}

function alternar(id: string, habilitado: boolean, sujeto: string, mutation: ConfigMutation): AccionDeFila {
  const verbo = habilitado ? 'Deshabilitar' : 'Habilitar';
  return { id, etiqueta: verbo, descripcion: `${verbo} ${sujeto}`, mutation };
}

/** Igual que `AliasSchema`/rol en `packages/protocol/src/schemas.ts`. */
const ROL = /^[a-z][a-z0-9_-]{0,63}$/;

/** Campos sin los que no se puede identificar la membership a la que cambiarle el rol. */
const IDENTIDAD_MEMBERSHIP = ['tenant_id', 'room_id', 'alias'] as const;

/**
 * Por qué NO se puede cambiar el rol de esta fila, o `undefined` si sí se puede.
 *
 * Existe porque el selector llamaba a `accionDeRol`, recibía `undefined` y se tragaba el clic sin
 * rastro: el operador elegía «operator», no pasaba nada y no había nada escrito que se lo
 * explicara. Un control que no puede hacer su trabajo se apaga y DICE por qué; quedarse mudo es
 * indistinguible de estar roto.
 */
export function motivoSinCambioDeRol(fila: Record<string, unknown>): string | undefined {
  const faltan = IDENTIDAD_MEMBERSHIP.filter((campo) => texto(fila, campo) === undefined);
  if (!faltan.length) return undefined;
  return `UNKNOWN: el servidor no publica ${faltan.join(', ')} en esta fila, así que no se puede `
    + 'armar la mutación de rol. Cambialo por el editor de mutaciones JSON.';
}

/**
 * Cambio de rol de una membership. Devuelve `undefined` cuando el rol pedido no pasa la misma
 * expresión que el zod del gateway, o cuando es el que la fila ya tiene: mandar una mutación que el
 * servidor va a rechazar —o que no cambia nada pero igual gasta una revisión— no es una acción.
 */
export function accionDeRol(fila: Record<string, unknown>, rol: string): AccionDeFila | undefined {
  const tenantId = texto(fila, 'tenant_id');
  const roomId = texto(fila, 'room_id');
  const alias = texto(fila, 'alias');
  const actual = texto(fila, 'role');
  const pedido = rol.trim();
  if (tenantId === undefined || roomId === undefined || alias === undefined) return undefined;
  if (!ROL.test(pedido) || pedido === actual) return undefined;
  return {
    id: 'role',
    etiqueta: `Rol ${pedido}`,
    descripcion: `Cambiar el rol de ${tenantId}/${roomId}/${alias} de ${actual ?? 'UNKNOWN'} a ${pedido}`,
    mutation: {
      resource: 'membership', action: 'update', tenant_id: tenantId, room_id: roomId, alias,
      value: { role: pedido },
    },
  };
}

/**
 * Roles que se ofrecen en el selector: los de `role_policies` —que son los únicos que el JOIN de
 * `assertControl` sabe resolver— más el que la fila ya tiene, aunque haya quedado huérfano. Ocultar
 * el rol actual haría que el selector mintiera sobre lo que la fila dice.
 */
export function rolesDisponibles(
  politicas: ReadonlyArray<Record<string, unknown>> | undefined,
  rolActual: string | undefined,
): string[] {
  const roles = (politicas ?? [])
    .map((fila) => texto(fila, 'role'))
    .filter((rol): rol is string => rol !== undefined);
  if (rolActual !== undefined && !roles.includes(rolActual)) roles.push(rolActual);
  return [...new Set(roles)].sort((izquierda, derecha) => izquierda.localeCompare(derecha));
}

import type { ConfigMutation } from '../../api/types';
import { claveDeFila } from './collection-table';

/**
 * Especificación pura de interruptores de configuración (toggles):
 * mapea campos booleanos de colecciones a sus mutaciones inversas y descripciones operativas.
 */

export interface Interruptor {
  /** Identifica el interruptor en toda la página: colección, fila y campo. */
  clave: string;
  coleccion: string;
  filaId: string;
  campo: string;
  /** Lo que el interruptor dice ahora, según el último snapshot bueno del servidor. */
  valor: boolean;
  /**
   * `aria-label` del control. Nombra la fila Y el permiso: un lector de pantalla que sólo dice
   * «Ruta» veinticuatro veces no permite saber de qué arista se está hablando.
   */
  aria: string;
  /** Lo que se afirma cuando se aplica. Sale en el aviso y en el mensaje de un rechazo. */
  descripcion: string;
  /** La mutación que lleva el campo a `!valor`. Parcial a propósito: ver el comentario de abajo. */
  mutation: ConfigMutation;
  /** Texto de la confirmación obligatoria, o `undefined` si no hace falta ninguna. */
  confirmar?: string;
}

/**
 * Qué campo de qué colección se conmuta, EN ORDEN. Lo que no está acá se sigue viendo como dato
 * —píldora «Sí»/«No»— y se edita por el editor de mutaciones: un interruptor que arma una mutación
 * que el servidor va a rechazar es peor que no ofrecer el interruptor.
 *
 * `is_hub` de un tenant NO está a propósito aunque sea booleano y el esquema lo acepte: mover el hub
 * de una flota no es una operación de un clic, y ponerla al lado de «Habilitado» invita a hacerla
 * sin querer.
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
 * Qué concede cada permiso, en castellano y en una frase. Va al tooltip de la cabecera de la
 * columna: `allow_route` es el nombre de una columna de Postgres, no una explicación, y el operador
 * que llega a esta pantalla necesita saber qué está encendiendo ANTES de encenderlo.
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

/** Cómo se nombra la fila en una frase. `undefined` si le falta identidad para armar la mutación. */
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

/** El nombre corto del permiso, para el `aria-label` y para el aviso. */
const NOMBRE_DE_CAMPO: Record<string, string> = {
  enabled: 'Habilitado', allow_route: 'Ruta', allow_read: 'Lectura',
  allow_control: 'Control', allow_notify: 'Aviso proactivo',
};

function nombreDeCampo(campo: string): string {
  return Object.hasOwn(NOMBRE_DE_CAMPO, campo) ? NOMBRE_DE_CAMPO[campo] : campo;
}

/**
 * La mutación PARCIAL que cambia un solo campo. Que sea parcial no es un atajo: el store hace merge
 * campo por campo contra la fila que leyó `FOR UPDATE`
 * (`has(value,'enabled') ? value.enabled : old.enabled`), así que mandar sólo `allow_read` no pisa
 * el `allow_route` que otro operador acaba de cambiar en la misma arista.
 *
 * Lo que el ENVÍO es parcial no lo es el DESHACER: la inversa que el store guarda en
 * `config_revisions` lleva la fila ENTERA que había antes. El panel del audit trail lo dice.
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
 * **La ÚNICA confirmación que queda en toda la pantalla.**
 *
 * Confirmar cada clic era el defecto, no la salvaguarda: veinte «¿seguro?» seguidos enseñan a
 * apretar «Confirmar» sin leer, y el día que aparece el que importa ya nadie lo lee. Se guarda para
 * lo que en la práctica no tiene vuelta atrás desde esta misma pantalla: **quitar `allow_control`**.
 * Quien se lo quita a sí mismo pierde el permiso de escribir configuración, y volver a concedérselo
 * exige a otra identidad que todavía lo tenga.
 *
 * Encender `allow_control` NO confirma: se deshace con un clic en el mismo interruptor.
 */
function confirmacion(campo: string, valor: boolean, sujeto: string): string | undefined {
  if (campo !== 'allow_control' || !valor) return undefined;
  return `Quitar Control en ${sujeto} deja sin poder escribir configuración, reinyectar entregas ni `
    + 'abrir terminales del otro lado. Si el permiso que estás quitando es el tuyo, no vas a poder '
    + 'devolvértelo desde acá: va a hacer falta otra identidad que todavía lo tenga.';
}

/**
 * El interruptor de un campo de una fila, o `undefined` si no se puede armar.
 *
 * Devuelve `undefined` —y la celda cae a la píldora de sólo lectura— en dos casos, los dos a
 * propósito: cuando el valor no es un booleano (no se puede escribir «el contrario» de algo que no
 * se conoce) y cuando la fila no trae los campos de identidad que la mutación necesita. Un
 * interruptor que no puede escribir es peor que un dato que no se puede tocar.
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

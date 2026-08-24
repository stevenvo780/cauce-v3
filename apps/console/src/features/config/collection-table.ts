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
/**
 * El rótulo de cada columna, en castellano.
 *
 * 🔴 **Lo que no está acá se pinta con el nombre de la columna de la base.** Medido el 2026-08-23:
 * las tablas mostraban cabeceras como `PROTOCOL_VERSION`, `LAST_SEEN_AT`, `CONTAINER_NAME`,
 * `RUNTIME_USER`, `HOME_DIRECTORY`, `PAYER_TENANT_ID`, `SHARED_WITH_POOL` y `EXTERNAL_ACCOUNT_ID`
 * —snake_case en inglés, en una interfaz en castellano— porque `columnasDe` cae al nombre crudo
 * cuando no hay entrada acá. No es una decisión: es el valor por defecto, y el valor por defecto
 * de una tabla que se alimenta del esquema es siempre el esquema.
 *
 * Los cuatro `allow_*` se dejan a propósito con su nombre técnico: son los nombres EXACTOS de las
 * columnas de `acl_edges` que se citan en los runbooks y en las consultas de diagnóstico, y
 * traducirlos rompería el puente entre lo que se ve y lo que se escribe en un `psql`.
 */
const ETIQUETAS: Record<string, string> = {
  id: 'Id', tenant_id: 'Tenant', room_id: 'Room', alias: 'Alias', role: 'Rol',
  display_name: 'Nombre', is_hub: 'Hub', enabled: 'Habilitado',
  created_at: 'Alta', updated_at: 'Última edición',
  from_tenant: 'Desde', to_tenant: 'Hacia',
  // Los cuatro permisos se llamaban como la columna de Postgres —`allow_route`, en inglés, en una
  // pantalla en castellano— y encima con la cabecera en mayúsculas: `ALLOW_ROUTE`. El nombre de la
  // columna no es una explicación de lo que concede, y quien la lee no puede deducirlo. Ahora se
  // llaman por lo que hacen, y QUÉ hacen se explica en el tooltip de la cabecera
  // (`EXPLICACION_DE_CAMPO` en `interruptores.ts`).
  allow_route: 'Ruta', allow_read: 'Lectura', allow_control: 'Control',
  allow_notify: 'Aviso proactivo', harness_id: 'Harness', command: 'Comando',
  capabilities: 'Capacidades', handle: 'Handle', adapter: 'Adaptador', channel: 'Canal',
  provider: 'Proveedor', account_id: 'Cuenta', agent_alias: 'Alias', priority: 'Prioridad',
  role_brief: 'Rol declarado', label: 'Etiqueta',
  // Añadidos el 2026-08-23: los ocho que salían con el nombre de la columna de la base.
  container_name: 'Contenedor', runtime_user: 'Usuario', home_directory: 'Carpeta personal',
  image_id: 'Imagen', generation: 'Generación',
  protocol_version: 'Protocolo', last_seen_at: 'Última señal', connected_since: 'Conectado desde',
  payer_tenant_id: 'Paga', shared_with_pool: 'En el pool', external_account_id: 'Id externo',
  credential_ref: 'Credencial', credential_ref_kind: 'Tipo de credencial', plan: 'Plan',
  account_label: 'Cuenta', window_key: 'Ventana', group_key: 'Grupo',
  max_priority: 'Prioridad máxima', rank: 'Orden', notes: 'Notas', reason: 'Motivo',
  expires_at: 'Vence', paused_until: 'Pausada hasta', paused_reason: 'Motivo de la pausa',
};

/**
 * Columnas que se funden en UNA de identidad.
 *
 * `Desde` y `Hacia` son dos columnas para un solo hecho —la arista— y separarlas obliga a leer dos
 * celdas y a reconstruir la dirección con la cabeza. Fundidas se leen de un golpe («Steven →
 * Miguel») y devuelven a la tabla el ancho que los interruptores necesitan.
 */
const IDENTIDAD_FUNDIDA: Record<string, { clave: string; etiqueta: string; campos: readonly string[]; union: string }> = {
  acl_edges: { clave: '__arista', etiqueta: 'Arista', campos: ['from_tenant', 'to_tenant'], union: ' → ' },
};

/** El texto de una columna fundida, o `undefined` si esta fila no trae los campos que la componen. */
export function identidadFundida(clave: string, fila: Record<string, unknown>): string | undefined {
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  if (!fusion) return undefined;
  const partes = fusion.campos.map((campo) => texto(fila, campo));
  return partes.every((parte) => parte !== undefined) ? partes.join(fusion.union) : undefined;
}

export function esColumnaFundida(clave: string, columna: string): boolean {
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  return fusion !== undefined && fusion.clave === columna;
}

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
  const fusion = Object.hasOwn(IDENTIDAD_FUNDIDA, clave) ? IDENTIDAD_FUNDIDA[clave] : undefined;
  // La fusión sólo se aplica si el servidor publica TODOS los campos que la componen: con uno solo
  // la columna quedaría a medias y el operador leería «Steven → » sin saber hacia dónde.
  const fundir = fusion !== undefined && fusion.campos.every((campo) => presentes.includes(campo));
  const orden = fundir && fusion
    ? [fusion.clave, ...presentes.filter((campo) => !fusion.campos.includes(campo)), ...extra]
    : [...presentes, ...extra];
  return orden.map((campo) => ({
    clave: campo,
    etiqueta: fundir && fusion && campo === fusion.clave
      ? fusion.etiqueta
      : Object.hasOwn(ETIQUETAS, campo) ? ETIQUETAS[campo] : campo,
  }));
}

/**
 * Si una columna es de NÚMEROS, para alinearla a la derecha.
 *
 * Una columna de números alineada a la izquierda obliga a comparar magnitudes contando dígitos:
 * `8` y `120` empiezan en el mismo píxel y el que PARECE más grande es el que tiene más
 * caracteres. En `/config` hay unas cuantas —`max_per_hour`, `max_per_day`, `contact_ttl_days`,
 * `min_interval_seconds`, `priority`, `generation`— y todas se leen para comparar.
 *
 * Exige que TODOS los valores presentes sean números y que haya al menos uno: una columna mixta
 * («12» en una fila y «sin límite» en otra) alineada a la derecha se lee peor que a la izquierda,
 * y un booleano en JavaScript no es un número pero sí lo parece si uno mira `typeof` con prisa.
 * Los nulos y las claves ausentes no cuentan: un `null` no desmiente que la columna sea numérica.
 */
export function columnaNumerica(filas: ReadonlyArray<Record<string, unknown>>, columna: string): boolean {
  let vistos = 0;
  for (const fila of filas) {
    if (!Object.hasOwn(fila, columna)) continue;
    const valor = fila[columna];
    if (valor === null || valor === undefined) continue;
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return false;
    vistos += 1;
  }
  return vistos > 0;
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

/**
 * Lo que el operador puede cambiar de una fila SIN salir de la tabla.
 *
 * Los booleanos —`enabled` y los tres permisos de una arista— ya no son botones: son interruptores,
 * y su lógica vive en `interruptores.ts`. Acá queda lo que no es un booleano y por lo tanto no es un
 * interruptor: el ROL de una membresía, que es una elección entre varios valores y para eso está el
 * `<select>` de su propia columna.
 */

export interface AccionDeRol {
  /** Estable dentro de la fila: identifica qué cambio está esperando confirmación. */
  id: string;
  /** Frase completa; sirve de encabezado de la confirmación y del cartel del desenlace. */
  descripcion: string;
  mutation: ConfigMutation;
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
export function accionDeRol(fila: Record<string, unknown>, rol: string): AccionDeRol | undefined {
  const tenantId = texto(fila, 'tenant_id');
  const roomId = texto(fila, 'room_id');
  const alias = texto(fila, 'alias');
  const actual = texto(fila, 'role');
  const pedido = rol.trim();
  if (tenantId === undefined || roomId === undefined || alias === undefined) return undefined;
  if (!ROL.test(pedido) || pedido === actual) return undefined;
  return {
    id: 'role',
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

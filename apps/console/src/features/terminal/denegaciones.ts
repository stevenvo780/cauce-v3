/**
 * Traducción y formato accesible de denegaciones y conflictos de terminal PTY:
 * mapea los códigos del gateway (`TerminalDenial`, `TerminalConflict`) a explicaciones operativas.
 */

/** Códigos de denegación 403/409 del gateway y estados de inventario. */
export type TerminalDenialCode =
  /** La consola no envió un token CSRF válido. */
  | 'csrf_missing'
  /** La cookie de consola no vale (o caducó). Tampoco es un permiso: es volver a entrar. */
  | 'unauthorized'
  | 'unknown_alias'
  | 'control_permission_required'
  | 'attribution_required'
  | 'no_routing_authority'
  | 'no_grant'
  | 'agent_offline'
  | 'session_limit'
  | 'container_busy'
  | 'request_conflict'
  | 'not_installed';

export interface TerminalDenialCopy {
  /** Titular. Una frase corta que se entiende sin saber nada del gateway. */
  titulo: string;
  /** La puerta que se cerró, dicha con lo que el operador puede comprobar. */
  porQue: string;
  /** A quién pedirle que la abra. Nunca «al administrador»: el rol concreto. */
  quienLoLevanta: string;
}

/**
 * El dueño del bus. No se escribe un nombre propio: quien opera esta consola cambia, y un
 * nombre quemado en el código envejece peor que un rol.
 */
const DUENO_DEL_BUS = 'el dueño del bus (quien administra Cauce)';

export const TERMINAL_DENY_MESSAGES: Readonly<Record<TerminalDenialCode, TerminalDenialCopy>> = {
  csrf_missing: {
    titulo: 'La consola no mandó su token CSRF',
    porQue: 'El gateway exige una cabecera `X-CSRF-Token` en toda escritura y esta petición salió sin '
      + 'ella, así que la rechazó antes de mirar tu permiso. No es tu permiso ni el alias: es la consola.',
    quienLoLevanta: 'quien mantiene la consola: no hay nada que puedas conceder para arreglarlo',
  },
  unauthorized: {
    titulo: 'La sesión de la consola caducó',
    porQue: 'El gateway no reconoció la sesión del navegador. No es un permiso que te falte: la cookie '
      + 'de consola venció o se invalidó, y hasta que vuelvas a entrar ninguna escritura pasa.',
    quienLoLevanta: 'vos mismo: volvé a entrar y reintentá',
  },
  unknown_alias: {
    titulo: 'Ese alias no está en el mapa de la flota',
    porQue: 'El gateway no encuentra al alias en su reparto de contenedores, o lo tiene en otro cliente '
      + 'distinto del que pediste. Sin saber en qué contenedor vive, no hay dónde abrir la sesión.',
    quienLoLevanta: `${DUENO_DEL_BUS}: hay que dar de alta el alias en el reparto de la flota, o corregir el cliente.`,
  },
  control_permission_required: {
    titulo: 'Tu cuenta no tiene permiso de control',
    porQue: 'La terminal es una operación de control sobre la flota y tu sesión no lo tiene concedido en la base. '
      + 'Es el MISMO permiso que pide «Ajustes y altas».',
    quienLoLevanta: `${DUENO_DEL_BUS}: te tiene que conceder el permiso «control» a tu alias de operador.`,
  },
  attribution_required: {
    titulo: 'Falta decir qué persona está entrando',
    porQue: 'Sin una persona con nombre detrás de la sesión, la auditoría no puede atribuir lo que pase dentro del '
      + 'contenedor. Sin esa identidad sólo se puede entrar a los alias de tu propio cliente, y este es de otro.',
    quienLoLevanta: 'Vos: entrá con una sesión con identidad de persona. Si ya entraste así, '
      + `pedile a ${DUENO_DEL_BUS} que revise cómo llega tu identidad al gateway.`,
  },
  no_routing_authority: {
    titulo: 'No tenés autoridad de ruteo sobre ese contenedor',
    porQue: 'Una shell alcanza a TODOS los alias que comparten el contenedor, así que el gateway exige que puedas '
      + 'hablarle a cada uno de ellos. Con que falte el permiso sobre uno solo, la puerta queda cerrada.',
    quienLoLevanta: `${DUENO_DEL_BUS}: hay que darte membresía o arista ACL hacia todos los alias de ese contenedor.`,
  },
  no_grant: {
    titulo: 'Tu operador no figura en la lista de permisos de la terminal',
    porQue: 'El gateway relee de disco el fichero de permisos de terminal en cada pedido, y ahí no aparece tu '
      + 'operador para este alias y este modo. No es un fallo del relay: el relay está sano y la lista dice que no.',
    quienLoLevanta: `${DUENO_DEL_BUS}: tiene que añadir tu operador al fichero de permisos de terminal, `
      + 'para ese alias y ese modo (TUI en vivo o shell son permisos distintos).',
  },
  agent_offline: {
    titulo: 'El agente PTY del contenedor no está conectado',
    porQue: 'Dentro del contenedor vive un agente que es el que abre la sesión, y el gateway no lo ve conectado '
      + '—o no publica el modo que pediste—. El permiso puede estar perfectamente bien: lo que falta es el agente.',
    quienLoLevanta: 'Nadie tiene que darte un permiso: hay que levantar el agente PTY dentro de ese contenedor. '
      + `Si no sabés quién lo maneja, es ${DUENO_DEL_BUS}.`,
  },
  session_limit: {
    titulo: 'Ya tenés abiertas todas las sesiones que te tocan',
    porQue: 'Hay un tope de sesiones simultáneas por operador y lo alcanzaste. Las sesiones que quedaron colgadas '
      + 'siguen contando hasta que vencen.',
    quienLoLevanta: 'Vos: cerrá alguna de las sesiones que tenés abiertas y volvé a pedir esta.',
  },
  container_busy: {
    titulo: 'Otro operador ya está dentro de ese contenedor',
    porQue: 'Dos operadores no comparten contenedor: la segunda shell leería el home de la primera. El gateway lo '
      + 'impide mientras la otra sesión siga viva.',
    quienLoLevanta: 'Quien tenga la sesión abierta, cerrándola. Se libera sola cuando vence.',
  },
  request_conflict: {
    titulo: 'El reintento ya no coincide con la reserva original',
    porQue: 'Ese identificador de apertura ya existe, pero cambió el destino, el motivo, la geometría '
      + 'o la capacidad dueña. El gateway no mezcla ambas operaciones ni entrega la reserva anterior.',
    quienLoLevanta: 'Vos: cerrá esta pestaña y abrí una intención nueva. Si fue sólo una pérdida de red, '
      + 'reintentá sin editar nada para conservar la misma identidad de la operación.',
  },
  not_installed: {
    titulo: 'Ese contenedor nunca tuvo agente PTY',
    porQue: 'No es que se haya caído: el gateway no vio jamás un agente PTY para ese alias. Es una instalación que '
      + 'falta, no una avería.',
    quienLoLevanta: `${DUENO_DEL_BUS}: hay que instalar el agente PTY en ese contenedor.`,
  },
};

/** Todos los códigos, para recorrerlos en las pruebas y en la ayuda de la vista. */
export const TERMINAL_DENIAL_CODES = Object.keys(TERMINAL_DENY_MESSAGES) as TerminalDenialCode[];

function esCodigo(value: string): value is TerminalDenialCode {
  return Object.hasOwn(TERMINAL_DENY_MESSAGES, value);
}

/**
 * Busca un código de denegación DENTRO de un texto del servidor.
 *
 * Hace falta porque el gateway manda el código de dos formas distintas: pelado en
 * `{reason:'no_grant'}` cuando rechaza el POST, y embebido en la prosa del inventario de destinos
 * (`'attribution_required: falta identidad por persona.'`). Las dos acaban en pantalla, así que las
 * dos tienen que traducirse. El borde de palabra evita que `no_grant` se encuentre dentro de
 * `no_grant_pendiente` o de una ruta.
 */
export function codigoDeDenegacion(texto: unknown): TerminalDenialCode | undefined {
  if (typeof texto !== 'string' || !texto.trim()) return undefined;
  const limpio = texto.trim();
  if (esCodigo(limpio)) return limpio;
  // El fallo de CSRF no llega como código: llega como prosa del gateway («se requiere un token
  // CSRF válido»). Es la única negativa que se reconoce por la palabra y no por el identificador.
  if (/csrf/i.test(limpio)) return 'csrf_missing';
  for (const codigo of TERMINAL_DENIAL_CODES) {
    if (new RegExp(`(^|[^a-z_])${codigo}([^a-z_]|$)`).test(limpio)) return codigo;
  }
  return undefined;
}

export interface DenegacionExplicada {
  /** El código crudo que se reconoció, para el `data-` y la auditoría. Nunca se pinta solo. */
  codigo?: TerminalDenialCode;
  /**
   * `true` cuando la culpa es de la CONSOLA y no del permiso del operador ni del alias. Lo pinta
   * la vista para no mandar a nadie a pedir un permiso que ya tiene.
   */
  esDefectoDeLaConsola?: boolean;
  titulo: string;
  porQue: string;
  quienLoLevanta?: string;
  /** El estado HTTP, cuando se conoce. La consola lo decía en ningún lado y es media respuesta. */
  estado?: number;
  /** Todo junto en una línea, para los sitios que sólo tienen un `title=` o un `aria-label`. */
  linea: string;
}

/**
 * Traduce un rechazo del plano PTY. **Nunca devuelve el código crudo como titular.**
 *
 * Cuando el código no se reconoce —un gateway más nuevo que esta consola— se dice exactamente eso
 * y se muestra el texto del servidor como cita, no como explicación: inventar una traducción para
 * un código que no conocemos sería peor que no traducirlo. Y se preserva el texto original, que es
 * lo único comprobable que hay.
 */
export function explicarDenegacionPty(entrada: {
  /** `reason` del cuerpo, o el `message` del error, o la prosa del inventario. */
  texto?: unknown;
  /** Estado HTTP, si lo hay. */
  estado?: number;
  /** Código explícito, cuando quien llama ya lo tiene separado. */
  codigo?: string;
}): DenegacionExplicada {
  const codigo = codigoDeDenegacion(entrada.codigo) ?? codigoDeDenegacion(entrada.texto);
  const estado = typeof entrada.estado === 'number' && Number.isFinite(entrada.estado) ? entrada.estado : undefined;
  const sufijoEstado = estado ? ` (HTTP ${estado}).` : '';

  if (codigo) {
    const copia = TERMINAL_DENY_MESSAGES[codigo];
    return {
      codigo,
      estado,
      ...(codigo === 'csrf_missing' ? { esDefectoDeLaConsola: true } : {}),
      titulo: copia.titulo,
      porQue: `${copia.porQue}${sufijoEstado}`,
      quienLoLevanta: copia.quienLoLevanta,
      linea: `${copia.titulo}. ${copia.porQue}${sufijoEstado} Lo levanta: ${copia.quienLoLevanta}`,
    };
  }

  const cita = typeof entrada.texto === 'string' && entrada.texto.trim() ? entrada.texto.trim() : undefined;
  const titulo = 'El servidor rechazó la sesión y no dijo por qué en un código que esta consola conozca';
  const porQue = cita
    ? `El gateway contestó, textualmente: «${cita}»${sufijoEstado || '.'} Esta consola no tiene traducción para eso, `
      + 'así que se cita en vez de inventarle un significado.'
    : `El gateway rechazó el pedido sin texto${sufijoEstado || '.'}`;
  return {
    estado,
    titulo,
    porQue,
    quienLoLevanta: `${DUENO_DEL_BUS}: pasale este texto tal cual; sale de los registros del gateway.`,
    linea: `${titulo}. ${porQue}`,
  };
}

/**
 * Reescribe una frase del servidor sustituyendo el código crudo por su castellano.
 *
 * Es para los sitios que YA muestran la prosa del inventario (`target.reason`) y donde tirar el
 * texto del servidor perdería información: se cambia sólo la palabra que nadie entiende. Si no hay
 * código reconocible, devuelve el texto intacto — no se toca lo que ya estaba bien.
 */
export function traducirCodigosEnTexto(texto: unknown): string {
  if (typeof texto !== 'string' || !texto.trim()) return typeof texto === 'string' ? texto : '';
  const codigo = codigoDeDenegacion(texto);
  if (!codigo) return texto;
  const copia = TERMINAL_DENY_MESSAGES[codigo];
  const resto = texto
    .replace(new RegExp(`(^|[^a-z_])${codigo}:?`), '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const cola = resto && resto !== texto.trim() ? ` ${resto.charAt(0).toUpperCase()}${resto.slice(1)}` : '';
  return `${copia.titulo}. ${copia.porQue}${cola} Lo levanta: ${copia.quienLoLevanta}`;
}

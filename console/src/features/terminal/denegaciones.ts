/**
 * Translation and accessible formatting of PTY terminal denials and conflicts: maps gateway codes
 * (`TerminalDenial`, `TerminalConflict`) to operational explanations.
 */

/** 403/409 denial codes from the gateway and inventory states. */
export type TerminalDenialCode =
  /** The console did not send a valid CSRF token. */
  | 'csrf_missing'
  /** The console cookie is invalid (or expired). It is not a permission: it is logging back in. */
  | 'unauthorized'
  | 'unknown_alias'
  | 'control_permission_required'
  | 'attribution_required'
  | 'no_routing_authority'
  | 'no_grant'
  | 'no_grant_for_operator'
  | 'no_recognized_mode'
  | 'writable_tui_disabled'
  | 'control_held'
  | 'extension_exhausted'
  | 'writable_requires_attribution'
  | 'writable_requires_named_operator'
  | 'agent_offline'
  | 'session_limit'
  | 'container_busy'
  | 'request_conflict'
  | 'not_installed';

interface TerminalDenialCopy {
  /** Headline. A short sentence understood without knowing anything about the gateway. */
  titulo: string;
  /** The door that closed, said in terms the operator can verify. */
  porQue: string;
  /** Who to ask to open it. Never "the administrator": the specific role. */
  quienLoLevanta: string;
}

/**
 * The bus owner. No proper name is written: whoever runs this console changes, and a name burned into
 * code ages worse than a role.
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
  no_grant_for_operator: {
    titulo: 'Tu operador no tiene concesión sobre ese alias',
    porQue: 'El fichero de permisos de terminal sí conoce el alias, pero ninguna de sus filas nombra a tu operador '
      + 'para el contenedor entero. Una fila comodín sólo abre los modos de sólo lectura; para escribir hace '
      + 'falta que la fila te nombre.',
    quienLoLevanta: `${DUENO_DEL_BUS}: tiene que añadir una fila con tu operador para todos los alias de ese contenedor.`,
  },
  no_recognized_mode: {
    titulo: 'El agente PTY habla un dialecto que este gateway no conoce',
    porQue: 'El agente está conectado, pero ninguno de los modos que publica figura entre los que este gateway '
      + 'entiende. Suele ser un agente más nuevo que el gateway: no es tu permiso ni tu concesión.',
    quienLoLevanta: `${DUENO_DEL_BUS}: hay que actualizar el gateway al mismo contrato que el agente PTY, o volver el agente atrás.`,
  },
  writable_tui_disabled: {
    titulo: 'La escritura sobre la TUI está apagada en este gateway',
    porQue: 'El interruptor de la TUI con teclado está en cero en la configuración del gateway, así que ningún '
      + 'operador puede abrir ni tomar una sesión con escritura, tenga o no concesión. Mirar sigue permitido.',
    quienLoLevanta: `${DUENO_DEL_BUS}: tiene que encender el interruptor de escritura del gateway y reiniciarlo.`,
  },
  control_held: {
    titulo: 'Otro operador tiene el control de esa TUI',
    porQue: 'El control se toma de a uno: mientras alguien lo tenga, el bus deja las entregas de ese alias en '
      + 'espera y nadie más teclea. El aviso dice quién lo tiene y hasta cuándo, nada más.',
    quienLoLevanta: 'Quien lo tiene, devolviéndolo. Si cerró la pestaña sin devolverlo, vence solo al terminar la sesión.',
  },
  extension_exhausted: {
    titulo: 'La sesión ya no admite más prórroga',
    porQue: 'Cada sesión tiene un techo total contado desde que se abrió, y la prórroga pedida no gana '
      + 'ventana sobre ese techo. No es tu permiso: es el tope de duración del gateway.',
    quienLoLevanta: 'Vos: cerrá la sesión y abrí una nueva. Si el techo es corto para el trabajo, '
      + `pedile a ${DUENO_DEL_BUS} que suba el tope total.`,
  },
  writable_requires_attribution: {
    titulo: 'Escribir en una TUI exige una persona con nombre',
    porQue: 'Pediste un modo con teclado (shell o TUI con escritura) desde una sesión sin identidad de persona. '
      + 'Mirar se puede sin nombre; teclear dentro del contenedor del agente, no: cada pulsación queda atribuida.',
    quienLoLevanta: 'Vos: entrá con una sesión con identidad de persona. Si ya entraste así, '
      + `pedile a ${DUENO_DEL_BUS} que revise cómo llega tu identidad al gateway.`,
  },
  writable_requires_named_operator: {
    titulo: 'Una concesión comodín no abre modos con teclado',
    porQue: 'La fila que te alcanza en el fichero de permisos de terminal es la comodín, y el gateway sólo la '
      + 'acepta para mirar. Para un modo con escritura la fila tiene que nombrar a tu operador.',
    quienLoLevanta: `${DUENO_DEL_BUS}: tiene que añadir una fila con tu operador y ese modo para ese alias.`,
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

/** All codes, to iterate them in tests and the view's help. */
export const TERMINAL_DENIAL_CODES = Object.keys(TERMINAL_DENY_MESSAGES) as TerminalDenialCode[];

function esCodigo(value: string): value is TerminalDenialCode {
  return Object.hasOwn(TERMINAL_DENY_MESSAGES, value);
}

/**
 * Looks up a denial code WITHIN a server-provided text.
 *
 * It is needed because the gateway sends the code in two different ways: bare in `{reason:'no_grant'}` when
 * it rejects the POST, and embedded in the prose of the destination inventory
 * (`'attribution_required: falta identidad por persona.'`). Both end up on screen, so both must be translated.
 * The word boundary prevents `no_grant` from being found inside `no_grant_pendiente` or inside a path.
 */
export function codigoDeDenegacion(texto: unknown): TerminalDenialCode | undefined {
  if (typeof texto !== 'string' || !texto.trim()) return undefined;
  const limpio = texto.trim();
  if (esCodigo(limpio)) return limpio;
  // The CSRF failure does not arrive as a code: it arrives as gateway prose ("se requiere un token CSRF
  // válido"). It is the only refusal recognized by the word, not by the identifier.
  if (/csrf/i.test(limpio)) return 'csrf_missing';
  for (const codigo of TERMINAL_DENIAL_CODES) {
    if (new RegExp(`(^|[^a-z_])${codigo}([^a-z_]|$)`).test(limpio)) return codigo;
  }
  return undefined;
}

export interface DenegacionExplicada {
  /** The raw code that was recognized, for the `data-` attribute and the audit. Never painted alone. */
  codigo?: TerminalDenialCode;
  /**
   * `true` when the blame is on the CONSOLE and not on the operator's permission or the alias. The view
   * paints it so it does not send anyone to ask for a permission they already have.
   */
  esDefectoDeLaConsola?: boolean;
  titulo: string;
  porQue: string;
  quienLoLevanta?: string;
  /** The HTTP status, when known. The console said it nowhere and that is half the answer. */
  estado?: number;
  /** Everything in one line, for places that only have a `title=` or an `aria-label`. */
  linea: string;
}

/**
 * Translates a refusal from the PTY plane. **Never returns the raw code as the headline.**
 *
 * When the code is not recognized —a gateway newer than this console— that is exactly what is said, and
 * the server text is shown as a quote, not as an explanation: inventing a translation for a code we do not
 * know would be worse than not translating it. And the original text is preserved, since that is the only
 * thing that can be checked.
 */
export function explicarDenegacionPty(entrada: {
  /** `reason` from the body, or the error's `message`, or the inventory prose. */
  texto?: unknown;
  /** HTTP status, if any. */
  estado?: number;
  /** Explicit code, when the caller already has it separated. */
  codigo?: string;
}): DenegacionExplicada {
  const codigo = codigoDeDenegacion(entrada.codigo) ?? codigoDeDenegacion(entrada.texto);
  const estado = typeof entrada.estado === 'number' && Number.isFinite(entrada.estado) ? entrada.estado : undefined;
  const sufijoEstado = estado ? ` (HTTP ${String(estado)}).` : '';

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
 * Rewrites a server sentence by substituting the raw code with its translation.
 *
 * It is for places that ALREADY show the inventory prose (`target.reason`) and where discarding the server
 * text would lose information: only the word nobody understands is replaced. If there is no recognizable
 * code, the text is returned untouched — what was already right is not touched.
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

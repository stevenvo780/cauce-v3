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
  | 'agent_busy'
  | 'extension_exhausted'
  | 'stale_terminal_owner'
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
 * Whoever can fix a permission in this company. No proper name is written: whoever runs this
 * console changes, and a name burned into code ages worse than a role.
 */
const ADMIN_EMPRESA = 'la persona que administra tu empresa';

export const TERMINAL_DENY_MESSAGES: Readonly<Record<TerminalDenialCode, TerminalDenialCopy>> = {
  csrf_missing: {
    titulo: 'La consola no mandó su token CSRF',
    porQue: 'El servidor exige una cabecera `X-CSRF-Token` en toda escritura y esta petición salió sin '
      + 'ella, así que la rechazó antes de mirar tu permiso. No es tu permiso ni el alias: es la consola.',
    quienLoLevanta: 'quien mantiene la consola: no hay nada que puedas conceder para arreglarlo',
  },
  unauthorized: {
    titulo: 'La sesión de la consola caducó',
    porQue: 'El servidor no reconoció la sesión del navegador. No es un permiso que te falte: la cookie '
      + 'de consola venció o se invalidó, y hasta que vuelvas a entrar ninguna escritura pasa.',
    quienLoLevanta: 'tú mismo: vuelve a entrar y reintenta',
  },
  unknown_alias: {
    titulo: 'Ese alias no está en el mapa de la flota',
    porQue: 'El servidor no encuentra al alias en su reparto de contenedores, o lo tiene en otro cliente '
      + 'distinto del que pediste. Sin saber en qué contenedor vive, no hay dónde abrir la sesión.',
    quienLoLevanta: `${ADMIN_EMPRESA}: hay que dar de alta el alias en el reparto de la flota, o corregir el cliente.`,
  },
  control_permission_required: {
    titulo: 'Tu cuenta no tiene permiso de control',
    porQue: 'La terminal es una operación de control sobre la flota y tu sesión no lo tiene concedido en la base. '
      + 'Es el MISMO permiso que pide «Ajustes y altas».',
    quienLoLevanta: `${ADMIN_EMPRESA}: te tiene que conceder el permiso «control» a tu alias de operador.`,
  },
  attribution_required: {
    titulo: 'Falta decir qué persona está entrando',
    porQue: 'Sin una persona con nombre detrás de la sesión, la auditoría no puede atribuir lo que pase dentro del '
      + 'contenedor. Sin esa identidad solo se puede entrar a los alias de tu propio cliente, y este es de otro.',
    quienLoLevanta: 'Tú: entra con una sesión con identidad de persona. Si ya entraste así, '
      + `pídele a ${ADMIN_EMPRESA} que revise cómo llega tu identidad al servidor.`,
  },
  no_routing_authority: {
    titulo: 'No tienes permiso sobre todos los agentes de ese contenedor',
    porQue: 'Abrir una terminal alcanza a todos los agentes que comparten el contenedor, así que hacen falta '
      + 'permisos sobre cada uno de ellos. Con que falte uno solo, la puerta queda cerrada.',
    quienLoLevanta: `${ADMIN_EMPRESA}: tiene que darte permiso sobre todos los agentes de ese contenedor `
      + 'en Ajustes → Acceso y roles → Concesiones de terminal.',
  },
  no_grant: {
    titulo: 'No tienes permiso para abrir la terminal de este agente',
    porQue: 'Nadie te ha dado permiso para entrar a la terminal de este agente. Mirar su TUI y abrir una '
      + 'terminal son permisos distintos: hace falta uno que te nombre a ti para este agente.',
    quienLoLevanta: `${ADMIN_EMPRESA}: te lo da en Ajustes → Acceso y roles → Concesiones de terminal. `
      + 'Si administras tú la empresa, entra ahí y dátelo.',
  },
  no_grant_for_operator: {
    titulo: 'No tienes permiso para abrir la terminal de este agente',
    porQue: 'Hay permisos de terminal para este agente, pero ninguno con tu nombre para todo el contenedor. '
      + 'Los permisos dados a todo el mundo solo dejan mirar; para escribir hace falta uno con tu nombre.',
    quienLoLevanta: `${ADMIN_EMPRESA}: te lo da en Ajustes → Acceso y roles → Concesiones de terminal. `
      + 'Si administras tú la empresa, entra ahí y dátelo.',
  },
  no_recognized_mode: {
    titulo: 'El programa de terminal de ese contenedor no se entiende con este servidor',
    porQue: 'El programa que abre la terminal dentro del contenedor está conectado, pero no ofrece ningún '
      + 'modo que este servidor conozca. Suele ser más nuevo que el servidor: no es tu permiso.',
    quienLoLevanta: `${ADMIN_EMPRESA}: hay que poner el servidor y ese programa en la misma versión.`,
  },
  writable_tui_disabled: {
    titulo: 'Escribir en la TUI está apagado',
    porQue: 'La escritura en la TUI está apagada para todo el mundo en este servidor, así que nadie puede '
      + 'abrir ni tomar una sesión con teclado, tenga o no permiso. Mirar sigue permitido.',
    quienLoLevanta: `${ADMIN_EMPRESA}: tiene que encender la escritura de la TUI en la configuración del servidor.`,
  },
  control_held: {
    titulo: 'Otro operador tiene el control de esa TUI',
    porQue: 'El control se toma de a uno: mientras alguien lo tenga, las entregas de ese alias quedan en '
      + 'espera y nadie más teclea. El aviso dice quién lo tiene y hasta cuándo, nada más.',
    quienLoLevanta: 'Quien lo tiene, devolviéndolo. Si cerró la pestaña sin devolverlo, vence solo al terminar la sesión.',
  },
  agent_busy: {
    titulo: 'El agente tiene un turno en curso',
    porQue: 'No se tomó el teclado. Puedes esperar y reintentar, o tomar control durante el turno '
      + 'de forma explícita. Esa toma pausa las entregas nuevas, pero no cancela la ejecución actual.',
    quienLoLevanta: 'Tú: si necesitas detener el turno, toma el control y usa Esc o Ctrl+C según la TUI. '
      + 'Verifica en pantalla que se detuvo antes de escribir.',
  },
  extension_exhausted: {
    titulo: 'La sesión ya no admite más prórroga',
    porQue: 'Cada sesión tiene un techo total contado desde que se abrió, y la prórroga pedida no gana '
      + 'ventana sobre ese techo. No es tu permiso: es el tope de duración del servidor.',
    quienLoLevanta: 'Tú: cierra la sesión y abre una nueva. Si el techo es corto para el trabajo, '
      + `pídele a ${ADMIN_EMPRESA} que suba el tope total.`,
  },
  stale_terminal_owner: {
    titulo: 'Esta pestaña ya no es la dueña de la sesión, o la sesión todavía no está enganchada',
    porQue: 'Solo se puede escribir en una sesión viva y abierta desde esta misma pestaña. O la sesión '
      + 'todavía no terminó de abrirse, o otra pestaña la tomó, o ya se cerró.',
    quienLoLevanta: 'Tú: espera a que la terminal muestre la sesión enganchada y reintenta; si otra pestaña '
      + 'la tomó, cierra esta y sigue desde aquella.',
  },
  writable_requires_attribution: {
    titulo: 'Escribir en una TUI exige una persona con nombre',
    porQue: 'Pediste un modo con teclado (shell o TUI con escritura) desde una sesión sin identidad de persona. '
      + 'Mirar se puede sin nombre; teclear dentro del contenedor del agente, no: cada pulsación queda atribuida.',
    quienLoLevanta: 'Tú: entra con una sesión con identidad de persona. Si ya entraste así, '
      + `pídele a ${ADMIN_EMPRESA} que revise cómo llega tu identidad al servidor.`,
  },
  writable_requires_named_operator: {
    titulo: 'Tu permiso de terminal solo deja mirar',
    porQue: 'El permiso que te alcanza es el dado a todo el mundo, y ese solo deja mirar. Para escribir '
      + '(abrir una terminal o teclear en la TUI) hace falta un permiso con tu nombre.',
    quienLoLevanta: `${ADMIN_EMPRESA}: te lo da en Ajustes → Acceso y roles → Concesiones de terminal. `
      + 'Si administras tú la empresa, entra ahí y dátelo.',
  },
  agent_offline: {
    titulo: 'El agente PTY del contenedor no está conectado',
    porQue: 'Dentro del contenedor vive un programa que es el que abre la sesión, y el servidor no lo ve conectado '
      + '—o no publica el modo que pediste—. El permiso puede estar perfectamente bien: lo que falta es el agente.',
    quienLoLevanta: 'Nadie tiene que darte un permiso: hay que levantar ese programa dentro del contenedor. '
      + `Si no sabes quién lo maneja, es ${ADMIN_EMPRESA}.`,
  },
  session_limit: {
    titulo: 'Ya tienes abiertas todas las sesiones que te tocan',
    porQue: 'Hay un tope de sesiones simultáneas por operador y lo alcanzaste. Las sesiones que quedaron colgadas '
      + 'siguen contando hasta que vencen.',
    quienLoLevanta: 'Tú: cierra alguna de las sesiones que tienes abiertas y vuelve a pedir esta.',
  },
  container_busy: {
    titulo: 'Otro operador ya está dentro de ese contenedor',
    porQue: 'Dos operadores no comparten contenedor: la segunda shell leería el home de la primera. El servidor lo '
      + 'impide mientras la otra sesión siga viva.',
    quienLoLevanta: 'Quien tenga la sesión abierta, cerrándola. Se libera sola cuando vence.',
  },
  request_conflict: {
    titulo: 'El reintento ya no coincide con la reserva original',
    porQue: 'Ese identificador de apertura ya existe, pero cambió el destino, el modo, la geometría '
      + 'o la capacidad dueña. El servidor no mezcla ambas operaciones ni entrega la reserva anterior.',
    quienLoLevanta: 'Tú: cierra esta pestaña y abre una intención nueva. Si fue solo una pérdida de red, '
      + 'reintenta sin editar nada para conservar la misma identidad de la operación.',
  },
  not_installed: {
    titulo: 'La conexión del agente PTY no está comprobada',
    porQue: 'El estado heredado no acredita una presencia del agente PTY. No se puede concluir si está instalado '
      + 'o si la conexión está caída.',
    quienLoLevanta: 'Tú: sincroniza el inventario o comprueba la presencia del agente en ese contenedor.',
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
    ? `El servidor contestó, textualmente: «${cita}»${sufijoEstado || '.'} Esta consola no tiene traducción para eso, `
      + 'así que se cita en vez de inventarle un significado.'
    : `El servidor rechazó el pedido sin texto${sufijoEstado || '.'}`;
  return {
    estado,
    titulo,
    porQue,
    quienLoLevanta: `${ADMIN_EMPRESA}: pásale este texto tal cual; sale de los registros del servidor.`,
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

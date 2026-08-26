/**
 * Redacción de secretos en la INGESTA, antes de que nada se persista.
 *
 * Este control nació de un incidente real en el que un mensaje contenía un archivo de entorno
 * completo y llegó a persistirse. La evidencia original se conserva fuera del código; este
 * comentario no incluye identificadores, endpoints ni fragmentos de credenciales.
 *
 * Se redacta acá, en el puente, y no más adelante, porque éste es el ÚLTIMO punto donde el texto
 * todavía no se escribió en ningún sitio. `StoreTelegramIngress.publish` ya persiste.
 *
 * ------------------------------------------------------------------------------------------
 * LA REGLA QUE MANDA: un falso positivo es PEOR que el problema.
 *
 * Mutilar el mensaje de un humano —dejarle un `[secreto-redactado]` en medio de una frase suya—
 * rompe el producto para todos los mensajes, todos los días, para tapar un caso que pasó una vez.
 * Por eso cada patrón de acá exige forma de credencial, no "parece sospechoso":
 *
 *   - la URI necesita `esquema://usuario:algo@` COMPLETO; una URL normal no matchea nunca;
 *   - `Authorization:` sólo se redacta si lo que sigue tiene 16+ caracteres Y contiene un dígito o
 *     un símbolo de los de base64. Sin eso, "Authorization: responsabilidades" (17 letras) se comía
 *     una palabra española legítima;
 *   - el token de bot exige `dígitos:` y 30+ caracteres con letras Y dígitos mezclados;
 *   - los prefijados (`sk-ant-`, `ghp_`, `AKIA`, `npg_`, `eyJ…`) son literalmente imposibles de
 *     escribir por accidente.
 *
 * Lo que NO se toca a propósito: `password=…`, `PGPASSWORD=…`, `token=…` sueltos y cualquier
 * `CLAVE=valor` genérico. "mi password es un desastre" es una frase normal, y una asignación
 * genérica no distingue una credencial de una opinión. Se prefiere dejar pasar un caso raro antes
 * que romper una conversación.
 *
 * Tampoco se redacta el EGRESO (lo que el agente le contesta al humano): ahí el destinatario es el
 * dueño del dato y taparle su propia credencial mientras la está depurando sería el falso positivo
 * más caro de todos. Este módulo cubre el camino humano → base.
 * ------------------------------------------------------------------------------------------
 */

export type RedactionKind =
  | 'uri_credentials'
  | 'authorization'
  | 'bearer_token'
  | 'telegram_bot_token'
  | 'api_key'
  | 'jwt'
  | 'private_key';

export interface RedactionResult {
  readonly value: string;
  /** Familias encontradas, ordenadas y sin repetir. Vacío = no se tocó nada. */
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
}

/** La marca que ve el agente y el humano. Deliberadamente autoexplicativa y en castellano. */
const MARK = '[secreto-redactado]';
const URI_MARK = '[credencial-redactada]';

interface Rule {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  /**
   * Devuelve el reemplazo, o `undefined` para dejar el texto intacto (guarda anti falso positivo).
   *
   * Los grupos llegan como lista CON los huecos: un grupo opcional que no participó vale
   * `undefined` y ocupa su posición. Filtrarlos correría los índices y haría que un patrón leyera
   * el grupo equivocado — que es exactamente cómo un redactor termina tapando lo que no debe.
   */
  replace(match: string, groups: readonly (string | undefined)[]): string | undefined;
}

/** Un token de verdad mezcla letras y dígitos; una palabra de un idioma humano no. */
function looksRandom(value: string): boolean {
  return /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
}

/** Base64/base64url o con separadores: lo que nunca es una palabra suelta. */
function looksLikeToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/u.test(value) && /[0-9._~+/=-]/u.test(value);
}

const RULES: readonly Rule[] = [
  // Bloque PEM completo. Si alguien pega una llave privada, no hay ambigüedad posible.
  {
    kind: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,20000}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
    replace: () => `${MARK} (llave privada)`
  },
  /**
   * URI con credenciales embebidas: el caso medido.
   *
   * Se conserva el esquema y el host a propósito. El agente casi siempre necesita saber CONTRA QUÉ
   * se estaba conectando el humano para poder ayudarlo; lo que no puede quedar escrito es el par
   * usuario/contraseña. Redactar la URI entera convertiría un mensaje útil en un jeroglífico.
   *
   * `[^\s/@:]` en el usuario y `[^\s/@]` en la clave son lo que impide que una URL normal matchee:
   * en `https://github.com/a/b` el primer grupo no puede cruzar la `/`, así que no hay `:` que
   * cerrar y el patrón muere antes de tocar nada.
   */
  {
    kind: 'uri_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,31}):\/\/([^\s/@:]{1,128}):([^\s/@]{1,256})@/giu,
    replace: (_match, groups) => `${groups[0]}://${URI_MARK}@`
  },
  /**
   * Cabecera Authorization en cualquiera de sus formas de escritura (`:` de HTTP, `=` de .env).
   *
   * Con un esquema declarado (`Bearer`, `Basic`, …) no hay ambigüedad y alcanza con 8 caracteres:
   * `Authorization: Basic dXNlcjpwYXNz` son 12 y es una credencial completa. Sin esquema hace falta
   * la guarda de forma, o "Authorization: responsabilidades" —una palabra española de 17 letras—
   * terminaría redactada.
   */
  {
    kind: 'authorization',
    pattern: /\b(authorization)(\s*[:=]\s*)(["']?)(?:(bearer|basic|token|digest)[ \t]+)?([^\s"',;]{8,4096})/giu,
    replace: (_match, groups) => {
      const [name, separator, quote, scheme, secret] = groups;
      if (scheme === undefined && !looksLikeToken(secret ?? '')) return undefined;
      return `${name}${separator}${quote ?? ''}${scheme === undefined ? '' : `${scheme} `}${MARK}`;
    }
  },
  // `Bearer <token>` suelto, sin la cabecera delante: es como se pega un token en un chat.
  {
    kind: 'bearer_token',
    pattern: /\b(bearer)[ \t]+([A-Za-z0-9._~+/=-]{16,4096})/giu,
    replace: (_match, groups) =>
      (looksLikeToken(groups[1] ?? '') ? `${groups[0]} ${MARK}` : undefined)
  },
  /**
   * Token de bot de Telegram. Es el secreto que más caro sale acá: con él, cualquiera lee y escribe
   * como el alias en TODOS sus chats. El formato es `<id numérico>:<35 caracteres base64url>`.
   */
  {
    kind: 'telegram_bot_token',
    pattern: /\b[0-9]{6,20}:[A-Za-z0-9_-]{30,200}\b/gu,
    replace: (match) => {
      const secret = match.slice(match.indexOf(':') + 1);
      return looksRandom(secret) ? MARK : undefined;
    }
  },
  // JWT: las tres partes separadas por punto, empezando por el `eyJ` del `{"` en base64.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/gu,
    replace: () => MARK
  },
  /**
   * Credenciales con prefijo propietario. Tasa de falso positivo esencialmente nula: nadie escribe
   * `ghp_` seguido de 36 caracteres aleatorios sin querer. `npg_` es el de Neon, el prefijo exacto
   * de la contraseña que se filtró el 02-ago.
   */
  {
    kind: 'api_key',
    pattern: new RegExp([
      '\\bsk-ant-[A-Za-z0-9_-]{20,200}',
      '\\bsk-[A-Za-z0-9]{32,200}',
      '\\bgh[pousr]_[A-Za-z0-9]{30,255}',
      '\\bgithub_pat_[A-Za-z0-9_]{40,255}',
      '\\bAKIA[0-9A-Z]{16}\\b',
      '\\bASIA[0-9A-Z]{16}\\b',
      '\\bxox[abprs]-[A-Za-z0-9-]{15,255}',
      '\\bnpg_[A-Za-z0-9]{12,255}',
      '\\bAIza[0-9A-Za-z_-]{35}',
      '\\bglpat-[A-Za-z0-9_-]{20,255}'
    ].join('|'), 'gu'),
    replace: () => MARK
  }
];

/** Cota de trabajo por valor: un texto absurdo no puede colgar la ingesta. */
const MAX_SCANNED_CHARACTERS = 256 * 1024;

/**
 * Interruptor de la redacción en la ingesta. POR DEFECTO NO REDACTA.
 *
 * Una decisión operativa documentada con evidencia privada mantiene esta redacción desactivada
 * por defecto: al activarla durante una instalación, una credencial necesaria llegó sustituida por
 * el marcador de redacción y el agente no pudo completar el trabajo.
 *
 * El riesgo de persistir el texto y la política de retención quedaron aceptados fuera del código.
 * No se transcriben aquí identidades, horarios, handles, cuerpos de mensaje ni datos de acceso.
 *
 * Se deja el módulo ENTERO vivo y encendible con `CAUCE_TELEGRAM_REDACT_INGRESS=1`, porque el
 * riesgo que documenta la cabecera de este archivo sigue siendo real para un tenant cliente que no
 * tenga esa limpieza. Borrar el código habría hecho falta escribirlo de nuevo para volver atrás.
 */
function redactionEnabled(): boolean {
  return process.env.CAUCE_TELEGRAM_REDACT_INGRESS === '1';
}

export function redactSecrets(value: string): RedactionResult {
  if (!redactionEnabled() || value.length === 0 || value.length > MAX_SCANNED_CHARACTERS) {
    return { value, kinds: [], count: 0 };
  }
  const kinds = new Set<RedactionKind>();
  let count = 0;
  let text = value;
  for (const rule of RULES) {
    // `replace` con función: cada guarda decide caso por caso, así que un patrón que dispara sobre
    // algo inocente devuelve el texto original en vez de romperlo.
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // `String.replace` pasa, después de los grupos, el offset (number) y la cadena completa
      // (string). Se cortan por tipo: los grupos son `string | undefined` y conservan su posición.
      const end = rest.findIndex((entry) => typeof entry === 'number');
      const groups = (end === -1 ? rest : rest.slice(0, end)) as readonly (string | undefined)[];
      const replacement = rule.replace(match, groups);
      if (replacement === undefined) return match;
      kinds.add(rule.kind);
      count += 1;
      return replacement;
    });
  }
  return { value: text, kinds: [...kinds].sort(), count };
}

/**
 * Claves cuyo valor NO se escanea.
 *
 * `content_base64` son los bytes de un adjunto ya validado por magic: pueden ser megas, no son
 * texto, y ninguna de las reglas de acá puede encontrar nada útil ahí dentro. Escanearlo sólo
 * gastaría CPU en cada foto que mande alguien.
 */
const OPAQUE_KEYS = new Set(['content_base64']);
const MAX_DEPTH = 8;

export interface DeepRedactionResult<T> {
  readonly value: T;
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
}

/**
 * Recorre el cuerpo entero y redacta TODA cadena.
 *
 * Deliberadamente no es una lista de campos ("redactá `text` y `caption`"): esa lista se queda
 * vieja el día que alguien agrega un campo nuevo —pasó con `prompt`, que nació mucho después que
 * `text`— y el secreto se cuela por el campo que nadie acordó de agregar. Recorrer todo y excluir
 * lo binario falla del lado seguro.
 */
export function redactSecretsDeep<T>(value: T): DeepRedactionResult<T> {
  const kinds = new Set<RedactionKind>();
  let count = 0;

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      if (result.count > 0) {
        count += result.count;
        for (const kind of result.kinds) kinds.add(kind);
      }
      return result.value;
    }
    if (depth >= MAX_DEPTH || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    const source = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      output[key] = OPAQUE_KEYS.has(key) ? entry : walk(entry, depth + 1);
    }
    return output;
  };

  return { value: walk(value, 0) as T, kinds: [...kinds].sort(), count };
}

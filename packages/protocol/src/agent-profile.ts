import { countCodePoints } from './schemas.js';

/**
 * EL PERFIL POR ALIAS: la forma y los topes de lo que un agente sabe de sí mismo.
 *
 * ============================================================================================
 * QUÉ PROBLEMA RESUELVE
 * ============================================================================================
 * La evidencia privada mostró, al medir la información fija que Cauce reinyecta en cada entrega,
 * que `protocolPrompt()` de un build desplegado con 13 destinos y un rol de
 * 1.097 caracteres:
 *
 *     sobre COMPLETO   : 11.546 caracteres
 *       andamiaje fijo :  9.210   <- se repite en CADA turno
 *       rol del alias  :  1.106   <- idem
 *       metadata JSON  :  1.168   <- esto sí es dinámico
 *       pedido real    :     62
 *     ratio            : 185 : 1
 *
 * Lo fijo tiene que vivir en el fichero del arnés (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, el
 * campo `agents` de `~/.openclaw/openclaw.json`), generado desde la configuración de la
 * plataforma; entre turnos sólo debería viajar lo dinámico.
 *
 * Este módulo es la primera mitad de eso: la FORMA de la fuente de verdad. La segunda —el
 * compilador que convierte un perfil en el texto de un fichero— vive en
 * `@cauce/adapter-sdk/src/context/`.
 *
 * ============================================================================================
 * POR QUÉ VIVE EN `@cauce/protocol` Y NO EN EL STORE
 * ============================================================================================
 * Exactamente el mismo motivo que `ROLE_BRIEF_MAX_CODE_POINTS`: es el número y la forma que
 * tienen que compartir capas que no se pueden importar entre sí. El CHECK de la migración 026 en
 * Postgres, el repositorio de `@cauce/store` y el compilador de `@cauce/adapter-sdk` miden todos
 * lo mismo, y `@cauce/protocol` es la única que las tres pueden importar sin ciclos.
 *
 * ============================================================================================
 * LA UNIDAD: SE MIDE EN LAS DOS Y MANDA LA MÁS ESTRICTA
 * ============================================================================================
 * Un incidente operativo dejó a un alias SORDO —sin entregas ni error visible— porque
 * dos capas medían el mismo 1200 en unidades distintas: `char_length` de Postgres cuenta PUNTOS DE
 * CÓDIGO y `z.string().max()` de zod cuenta unidades UTF-16. Un texto de 1200 puntos de código con
 * cien emojis mide 1300 en UTF-16: la base lo guardaba, la pantalla decía «guardado» y el
 * adaptador rechazaba el sobre entero.
 *
 * `agents.role_brief` (migración 020) cerró esa grieta haciendo que TODAS las capas contaran
 * puntos de código. Acá se cierra al revés, y es la decisión deliberada de este módulo: se mide en
 * LAS DOS unidades y se obedece a la MÁS ESTRICTA.
 *
 * Que la más estricta sea siempre la UTF-16 no es una opinión, es aritmética: un punto de código
 * del BMP vale 1 unidad UTF-16 y uno fuera del BMP vale 2, así que
 *
 *     unidadesUtf16(t) >= puntosDeCodigo(t)   para todo t
 *
 * y por lo tanto `max(...)` es siempre la cuenta UTF-16. Aun así `measureStrictestUnits` está
 * escrita como el máximo explícito y no como `text.length`, porque el invariante que importa es
 * «la más estricta», no «la UTF-16»: si algún día aparece una tercera unidad, se suma al máximo y
 * ninguna capa cambia. `tests/unit/agent-profile.test.ts` MIDE la desigualdad en vez de darla por
 * supuesta.
 *
 * Del lado de Postgres la misma cuenta se expresa como
 *
 *     char_length(t) + (char_length(t) - char_length(regexp_replace(t, '[\U00010000-\U0010FFFF]', '', 'g')))
 *
 * es decir «puntos de código + los que están fuera del BMP», que es la definición de la longitud
 * UTF-16. La migración 026 la encapsula en `cauce_utf16_units(text)` y comprobado contra
 * `String.length` de Node sobre los mismos textos da el MISMO número.
 */

/**
 * Largo en UNIDADES UTF-16, que es lo que mide `String.length` de JS y lo que contaba
 * `z.string().max()` el día que dejó a un alias sordo.
 *
 * Está escrita aparte, y no en línea, para que las dos unidades tengan NOMBRE en el código: la
 * confusión del incidente fue posible porque una de las dos no tenía nombre y se leía como «el largo».
 */
export function countUtf16Units(text: string): number {
  return text.length;
}

/**
 * La cuenta que MANDA: la más estricta de las dos.
 *
 * Toda guarda de tamaño de este módulo —y el CHECK de la migración 026— usa ésta y sólo ésta.
 */
export function measureStrictestUnits(text: string): number {
  return Math.max(countCodePoints(text), countUtf16Units(text));
}

/**
 * Los topes del perfil, en la unidad de `measureStrictestUnits`.
 *
 * ESTOS NÚMEROS ESTÁN ESPEJADOS EN LA MIGRACIÓN 026 y son la única copia del lado del código. Si
 * se cambian acá, se cambian allá en el mismo lote; la columna de Postgres es la que no se puede
 * mover sin migración, así que en un desacuerdo MANDA EL SQL.
 *
 * Por qué son mucho más grandes que los 1.200 de `role_brief`: `role_brief` viaja en el sobre de
 * CADA entrega y compite con el pedido real, así que su tope es un presupuesto de tokens por
 * turno. El perfil NO viaja: se escribe una vez en el fichero del arnés y el modelo lo lee de su
 * propio contexto. Su tope no protege el turno, protege el fichero.
 *
 * `total` es el que de verdad importa —es el techo del bloque generado— y por eso existe además
 * de los topes por campo: sin él, cuatro listas llenas dan 256.000 unidades con cada campo
 * «dentro de su tope».
 */
export const AGENT_PROFILE_LIMITS = {
  /** Identidad y propósito: para qué existe este alias. */
  purpose: 2_000,
  /** Rol declarado. Sucesor de `role_brief`, con sitio para el detalle que allá no cabía. */
  role_summary: 4_000,
  /**
   * Quién es el humano de este alias y cómo tratarlo.
   *
   * Existe porque el arnés `openclaw` lee un `USER.md` aparte —uno de sus Markdown gestionados—
   * y ninguna de las otras caras responde esa pregunta. Sin este campo el generador
   * tendría dos salidas y las dos malas: dejar `USER.md` vacío, o rellenarlo deduciendo el humano
   * del `tenant_id`, que es inventarle a un agente cómo tratar a una persona. Un fichero de persona
   * equivocado es peor que ninguno.
   *
   * Es el mismo tope que `purpose` y por el mismo motivo: describe, no enumera.
   */
  human_brief: 2_000,
  /** Tope de UN elemento de cualquiera de las listas. */
  item: 1_000,
  /** Tope de CUÁNTOS elementos admite una lista. */
  items: 64,
  /** Techo del perfil entero, sumando todos los campos. Es el techo del bloque generado. */
  total: 24_000
} as const;

/** Las listas del perfil, en el orden en que se suman al presupuesto y se renderizan. */
export const AGENT_PROFILE_LIST_FIELDS = [
  'responsibilities', 'restrictions', 'tools', 'operating_rules'
] as const;

/** Los textos sueltos del perfil, en el mismo orden. */
export const AGENT_PROFILE_TEXT_FIELDS = ['purpose', 'role_summary', 'human_brief'] as const;

export type AgentProfileListField = (typeof AGENT_PROFILE_LIST_FIELDS)[number];
export type AgentProfileTextField = (typeof AGENT_PROFILE_TEXT_FIELDS)[number];
export type AgentProfileField = AgentProfileListField | AgentProfileTextField;

/**
 * El perfil AUTORADO de un alias: lo que una persona escribió, sin nada derivado.
 *
 * Los nombres de campo son los de las columnas de `agent_profiles` (migración 026) y están en
 * inglés como todo el esquema, para que la traducción SQL <-> TS sea 1:1 y no haya un sitio donde
 * equivocarse. Los permisos, las cuotas y la configuración del arnés NO están acá a propósito: son
 * HECHOS derivados de `memberships`, `role_policies`, `provider_accounts` y `agents`, y duplicarlos
 * como texto autorado sería fabricar una segunda fuente de verdad que se desincroniza en silencio.
 * El compilador los recibe aparte y los une en el fichero.
 */
export interface AgentProfile {
  readonly tenant_id: string;
  readonly alias: string;
  /** Identidad y propósito. NULL = no declarado; el compilador OMITE la sección. */
  readonly purpose: string | null;
  /** Rol declarado. NULL = no declarado. */
  readonly role_summary: string | null;
  /**
   * Quién es su humano y cómo tratarlo. NULL = no declarado, y el generador OMITE el `USER.md`
   * de openclaw en vez de sembrarlo con una deducción.
   */
  readonly human_brief: string | null;
  readonly responsibilities: readonly string[];
  readonly restrictions: readonly string[];
  readonly tools: readonly string[];
  readonly operating_rules: readonly string[];
}

/**
 * Un perfil rechazado, con el CAMPO que lo rechazó.
 *
 * `field` no es decoración: la pantalla de configuración necesita saber qué caja pintar en rojo, y
 * sin él el operador recibe «no entra» sobre un formulario de siete campos.
 */
export class AgentProfileError extends Error {
  constructor(readonly field: AgentProfileField | 'total' | 'tenant_id' | 'alias', message: string) {
    super(message);
    this.name = 'AgentProfileError';
  }
}

function requireIdentifier(value: unknown, field: 'tenant_id' | 'alias'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentProfileError(field, `agent profile ${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Un texto suelto del perfil. En blanco vale NULL y NUNCA la cadena vacía.
 *
 * Es la misma regla que `normalizeRoleBrief()` en el store y por el mismo motivo: el compilador
 * decide OMITIR una sección mirando si es NULL, y una cadena vacía le haría emitir un encabezado
 * sin nada debajo. Una sección vacía en el fichero de un agente no es neutral: enseña que el
 * sistema no sabe la respuesta, que es peor que no preguntar.
 */
function normalizeText(value: unknown, field: AgentProfileTextField): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new AgentProfileError(field, `agent profile ${field} must be text or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const units = measureStrictestUnits(trimmed);
  const limit = AGENT_PROFILE_LIMITS[field];
  if (units > limit) {
    throw new AgentProfileError(
      field, `agent profile ${field} admits ${limit} characters at most; ${units} were sent`
    );
  }
  return trimmed;
}

/**
 * Una lista del perfil. Los elementos en blanco se DESCARTAN, no se rechazan.
 *
 * Descartar y no rechazar es deliberado: un renglón vacío en un formulario es un accidente de
 * edición, no una intención, y hacer fallar el guardado entero por él le cuesta al operador el
 * trabajo de los otros sesenta y tres. Lo que sí se rechaza es lo que no se puede interpretar
 * —un elemento que no es texto— y lo que no entra.
 */
function normalizeList(value: unknown, field: AgentProfileListField): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentProfileError(field, `agent profile ${field} must be a list of texts`);
  }
  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new AgentProfileError(field, `every ${field} entry must be text`);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const units = measureStrictestUnits(trimmed);
    if (units > AGENT_PROFILE_LIMITS.item) {
      throw new AgentProfileError(
        field,
        `every ${field} entry admits ${AGENT_PROFILE_LIMITS.item} characters at most; ${units} were sent`
      );
    }
    items.push(trimmed);
  }
  if (items.length > AGENT_PROFILE_LIMITS.items) {
    throw new AgentProfileError(
      field,
      `agent profile ${field} admits ${AGENT_PROFILE_LIMITS.items} entries at most; ${items.length} were sent`
    );
  }
  return items;
}

/**
 * Lo que ocupa un perfil, en la unidad estricta. Es la MISMA suma que hace el CHECK
 * `agent_profiles_budget` de la migración 026, en el mismo orden y sobre los mismos campos.
 */
export function agentProfileUnits(profile: AgentProfile): number {
  let total = 0;
  for (const field of AGENT_PROFILE_TEXT_FIELDS) {
    total += measureStrictestUnits(profile[field] ?? '');
  }
  for (const field of AGENT_PROFILE_LIST_FIELDS) {
    for (const item of profile[field]) total += measureStrictestUnits(item);
  }
  return total;
}

/**
 * Valida y normaliza un perfil venido de fuera (pantalla, API o una fila de la base).
 *
 * El orden de las comprobaciones importa y es el mismo que el de los CHECK de la migración 026:
 * primero cada campo contra su tope, después el presupuesto TOTAL. Al revés, un perfil con un
 * único campo monstruoso se rechazaría con «no entra el total» y el operador no sabría cuál
 * recortar.
 */
export function normalizeAgentProfile(input: Record<string, unknown>): AgentProfile {
  const profile: AgentProfile = {
    tenant_id: requireIdentifier(input['tenant_id'], 'tenant_id'),
    alias: requireIdentifier(input['alias'], 'alias'),
    purpose: normalizeText(input['purpose'], 'purpose'),
    role_summary: normalizeText(input['role_summary'], 'role_summary'),
    human_brief: normalizeText(input['human_brief'], 'human_brief'),
    responsibilities: normalizeList(input['responsibilities'], 'responsibilities'),
    restrictions: normalizeList(input['restrictions'], 'restrictions'),
    tools: normalizeList(input['tools'], 'tools'),
    operating_rules: normalizeList(input['operating_rules'], 'operating_rules')
  };
  const units = agentProfileUnits(profile);
  if (units > AGENT_PROFILE_LIMITS.total) {
    throw new AgentProfileError(
      'total',
      `agent profile admits ${AGENT_PROFILE_LIMITS.total} characters in total; ${units} were sent`
    );
  }
  return profile;
}

/** Un perfil vacío pero válido. Es lo que ve el compilador de un alias sin perfil escrito. */
export function emptyAgentProfile(tenantId: string, alias: string): AgentProfile {
  return {
    tenant_id: tenantId, alias, purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: []
  };
}

/**
 * ── LOS HECHOS DERIVADOS ────────────────────────────────────────────────────────────────────
 *
 * Las tres caras del fichero que NO se escriben a mano: permisos, cuotas y configuración del
 * arnés. Ya existen como filas en `memberships`/`role_policies`, en el camino
 * `agent_account_bindings` -> `alias_routing_ceiling` -> `provider_accounts` (+ `quota_window_state`)
 * y en `agents` + `harness_definitions`.
 *
 * Viven acá, y no en `@cauce/adapter-sdk`, por lo mismo que `AgentProfile`: los produce
 * `@cauce/store` y los consume `@cauce/adapter-sdk`, que no se pueden importar entre sí.
 * `@cauce/protocol` es la única que las dos ven.
 *
 * NO SE GUARDAN EN `agent_profiles`, y esa es la decisión que sostiene todo: copiarlos como texto
 * autorado sería una segunda fuente de verdad que se desincroniza en silencio — se revoca el
 * permiso en `role_policies` y el fichero del contenedor sigue diciendo que lo tiene. Se leen
 * frescos cada vez que se genera.
 */

/** Permisos EFECTIVOS: la unión de lo que conceden todas las salas del alias. */
export interface PermisosDelAlias {
  readonly ruta: boolean;
  readonly lectura: boolean;
  readonly control: boolean;
  /**
   * Notificar a un humano exige DOS puertas y las dos son necesarias: que el rol lo permita
   * (`role_policies.allow_notify`) y que exista al menos un destino aprobado
   * (`egress_destinations.enabled`). Sin destinos la respuesta es NO, aunque el rol diga que sí:
   * `notify` es default-deny por lista, no por rol.
   */
  readonly notificacion: boolean;
}

/**
 * Una suscripción a la que el alias puede ser ruteado.
 *
 * NUNCA lleva `credential_ref` ni `credential_ref_kind`. No es un descuido de campos: un perfil se
 * escribe en un fichero DENTRO del contenedor y se enseña al modelo, así que cualquier localizador
 * de credencial que entre acá termina en el contexto de un LLM y en los transcripts. El alias no
 * necesita saber dónde está la llave para usarla; el adaptador la resuelve por su cuenta.
 */
export interface CuotaDelAlias {
  readonly proveedor: string;
  readonly cuenta: string;
  /** Descripción legible del límite observado. Nunca un secreto. */
  readonly limite?: string | undefined;
}

/** Cómo está montado el alias. Sale de `agents` + `harness_definitions`. */
export interface ArnesDelAlias {
  readonly harness: string;
  readonly home: string;
  readonly contenedor?: string | undefined;
  readonly capacidades: readonly string[];
}

/** Todo lo derivado, junto: lo que el compilador une al perfil autorado. */
export interface HechosDelAlias {
  readonly permisos: PermisosDelAlias;
  readonly cuotas: readonly CuotaDelAlias[];
  readonly arnes: ArnesDelAlias;
  /** Alias alcanzables por ACL. Inventario de respaldo, igual que `routing_targets` en el sobre. */
  readonly destinos: readonly string[];
}

/** El perfil autorado más sus hechos: lo único que el compilador necesita para generar. */
export interface ContextoDeAlias {
  readonly perfil: AgentProfile;
  readonly hechos: HechosDelAlias;
}

/**
 * ── LA COMPOSICIÓN: perfil + hechos -> el texto del bloque ──────────────────────────────────
 *
 * Vive acá, y no en `@cauce/adapter-sdk`, por la MISMA razón que los tipos de arriba: la producen
 * y la consumen capas que no se pueden importar entre sí. El adaptador la usa para sembrar el
 * fichero del contenedor; el gateway la necesita para enseñarle al operador una VISTA PREVIA de
 * lo que se va a escribir antes de que se escriba. `@cauce/protocol` es la única que las dos ven.
 *
 * Que la vista previa y la siembra salgan de la MISMA función no es comodidad: es la única forma
 * de que la previsualización no mienta. Dos implementaciones del mismo texto divergen a la primera
 * corrección, y el operador aprobaría un bloque distinto del que acaba en el disco — sin que nada
 * diera error, porque cada una por su lado estaría bien.
 *
 * `@cauce/adapter-sdk` la RE-EXPORTA desde `context/perfil-a-contexto.ts`, así que nada de lo que
 * ya la importaba cambia de sitio.
 */

/** Una viñeta Markdown por elemento, en el orden en que vino. */
export function vinetas(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Una sección con su encabezado, o `undefined` si no hay cuerpo.
 *
 * Devolver `undefined` y no una cadena vacía es lo que hace que la sección desaparezca entera en
 * vez de dejar un encabezado hueco. Un encabezado sin nada debajo le enseña al agente que el
 * sistema no sabe la respuesta, que es peor que no preguntar — la misma regla por la que el
 * adaptador omite `Tu rol:` cuando el brief es NULL; un fixture sintético fija la misma regla.
*/
export function seccion(titulo: string, cuerpo: string | undefined): string | undefined {
  if (cuerpo === undefined || cuerpo.trim().length === 0) return undefined;
  return `## ${titulo}\n\n${cuerpo.trim()}`;
}

/**
 * Los permisos se dicen por su EFECTO y los denegados se nombran igual que los concedidos.
 *
 * Nombrar sólo lo concedido deja al agente adivinando si lo que falta es que no lo tiene o que
 * nadie lo escribió, y un agente que no sabe si puede hacer algo lo intenta. Decir «control: no»
 * cierra esa duda y cuesta cuatro palabras.
 */
export function lineasDePermisos(permisos: PermisosDelAlias): string {
  const marca = (concedido: boolean): string => (concedido ? "sí" : "no");
  return [
    `- Rutear mensajes a otros alias: ${marca(permisos.ruta)}`,
    `- Leer el estado de la flota: ${marca(permisos.lectura)}`,
    `- Cambiar configuración (control): ${marca(permisos.control)}`,
    `- Avisar a un humano por notify: ${marca(permisos.notificacion)}`,
  ].join("\n");
}

export function lineasDeCuotas(cuotas: readonly CuotaDelAlias[]): string | undefined {
  if (cuotas.length === 0) return undefined;
  return cuotas
    .map((cuota) => {
      const limite = cuota.limite === undefined ? "" : ` — ${cuota.limite}`;
      return `- ${cuota.proveedor} / ${cuota.cuenta}${limite}`;
    })
    .join("\n");
}

export function lineasDeArnes(hechos: HechosDelAlias): string {
  const lineas = [`- Arnés: ${hechos.arnes.harness}`, `- HOME: ${hechos.arnes.home}`];
  if (hechos.arnes.contenedor !== undefined && hechos.arnes.contenedor.length > 0) {
    lineas.push(`- Contenedor: ${hechos.arnes.contenedor}`);
  }
  if (hechos.destinos.length > 0) {
    lineas.push(`- Alias alcanzables: ${[...hechos.destinos].join(", ")}`);
  }
  return lineas.join("\n");
}

/**
 * EL ORDEN DE LAS SECCIONES ES FIJO Y ESTÁ DECLARADO ACÁ.
 *
 * De arriba abajo: quién sos -> qué te toca -> qué podés -> con qué contás -> cómo está montado ->
 * cómo se funciona. Es el mismo criterio de lectura que `protocolPrompt`: el agente lee primero su
 * identidad y sólo al final la mecánica.
 *
 * Está escrito como una lista y no como concatenación suelta para que el determinismo sea
 * estructural: cambiar el orden exige cambiar esta lista, no puede pasar por accidente.
 */
export function componerBloqueDePerfil(perfil: AgentProfile, hechos: HechosDelAlias): string {
  const rol = [
    perfil.role_summary ?? undefined,
    perfil.responsibilities.length > 0
      ? `Responsabilidades:\n${vinetas(perfil.responsibilities)}`
      : undefined,
    perfil.restrictions.length > 0
      ? `Restricciones:\n${vinetas(perfil.restrictions)}`
      : undefined,
  ].filter((parte): parte is string => parte !== undefined).join("\n\n");

  const herramientas = [
    perfil.tools.length > 0 ? vinetas(perfil.tools) : undefined,
    hechos.arnes.capacidades.length > 0
      ? `Capacidades del arnés: ${[...hechos.arnes.capacidades].join(", ")}`
      : undefined,
  ].filter((parte): parte is string => parte !== undefined).join("\n\n");

  const secciones = [
    seccion("Identidad y propósito", perfil.purpose ?? undefined),
    seccion("Rol, responsabilidades y restricciones", rol),
    // Va DESPUÉS del rol y antes de los permisos: primero quién sos y qué te toca, después con
    // quién tratás, y sólo entonces la mecánica. `openclaw` lee esta cara en un fichero aparte
    // —`USER.md`—, así que la sección tiene que existir por separado y no diluida dentro del rol.
    seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined),
    // Los permisos SIEMPRE se emiten si el perfil tiene alguna otra cara: un alias sin permisos
    // declarados es un hecho, no una ausencia, y saberlo le evita intentar lo que no puede.
    seccion("Permisos y acceso vía Cauce", lineasDePermisos(hechos.permisos)),
    seccion("Cuotas y límites", lineasDeCuotas(hechos.cuotas)),
    seccion("Herramientas y capacidades", herramientas),
    seccion("Configuración del arnés", lineasDeArnes(hechos)),
    seccion("Instrucciones fijas de funcionamiento",
      perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
  ].filter((parte): parte is string => parte !== undefined);

  /*
   * Un perfil ENTERAMENTE vacío produce texto vacío, no un esqueleto de encabezados. Los permisos
   * y la configuración del arnés son hechos que siempre existen, así que sin este corte un alias
   * sin nada escrito recibiría un fichero que sólo le dice en qué contenedor corre — ruido con
   * forma de contrato. `componerRolDelPerfil` devolviendo "" es la señal de «no hay perfil», y el
   * llamador omite la línea `Tu rol:` igual que hoy omite un `role_brief` NULL.
   */
  const hayAutorado =
    (perfil.purpose ?? null) !== null || (perfil.role_summary ?? null) !== null ||
    (perfil.human_brief ?? null) !== null ||
    perfil.responsibilities.length > 0 || perfil.restrictions.length > 0 ||
    perfil.tools.length > 0 || perfil.operating_rules.length > 0;
  if (!hayAutorado) return "";

  return secciones.join("\n\n");
}

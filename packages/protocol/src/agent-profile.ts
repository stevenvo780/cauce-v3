import { countCodePoints } from './schemas.js';

/**
 * Perfil por alias: tipos, límites y validación de la configuración de un agente.
 *
 * Regla de doble unidad:
 * Para evitar inconsistencias entre capas (PostgreSQL midiendo puntos de código y JS/Zod midiendo
 * unidades UTF-16), las longitudes se validan con la más estricta de ambas:
 * `measureStrictestUnits(t) = Math.max(countCodePoints(t), countUtf16Units(t))`.
 */

/** Largo en unidades UTF-16 (`String.length`). */
export function countUtf16Units(text: string): number {
  return text.length;
}

/** Longitud calculada con la unidad más estricta (máximo entre puntos de código y UTF-16). */
export function measureStrictestUnits(text: string): number {
  return Math.max(countCodePoints(text), countUtf16Units(text));
}

/** Límites de longitud por campo y acumulados para el perfil de agente. */
export const AGENT_PROFILE_LIMITS = {
  /** Identidad y propósito: para qué existe este alias. */
  purpose: 2_000,
  /** Rol declarado del agente. */
  role_summary: 4_000,
  /** Instrucciones de interacción con el usuario humano. */
  human_brief: 2_000,
  /** Límite de caracteres para un elemento individual de lista. */
  item: 1_000,
  /** Cantidad máxima de elementos admitidos en una lista. */
  items: 64,
  /** Límite acumulado de caracteres para el perfil completo. */
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

/** Perfil autorado de un alias. */
export interface AgentProfile {
  readonly tenant_id: string;
  readonly alias: string;
  /** Identidad y propósito. NULL = no declarado. */
  readonly purpose: string | null;
  /** Rol declarado. NULL = no declarado. */
  readonly role_summary: string | null;
  /** Instrucciones de interacción con el humano. NULL = no declarado. */
  readonly human_brief: string | null;
  readonly responsibilities: readonly string[];
  readonly restrictions: readonly string[];
  readonly tools: readonly string[];
  readonly operating_rules: readonly string[];
}

/** Error de validación en campos del perfil de agente. */
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

/** Normaliza un campo de texto; devuelve null si está vacío y valida límites. */
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

/** Normaliza una lista descartando elementos vacíos y validando límites. */
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

/** Calcula las unidades totales ocupadas por el perfil. */
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

/** Valida y normaliza la entrada de un perfil de agente. */
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

/** Crea una estructura de perfil vacía para un alias. */
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

/** Cuotas asignadas al alias para proveedores externos. */
export interface CuotaDelAlias {
  readonly proveedor: string;
  readonly cuenta: string;
  /** Descripción legible del límite observado. */
  readonly limite?: string | undefined;
}

/** Configuración de ejecución y capacidades del arnés. */
export interface ArnesDelAlias {
  readonly harness: string;
  readonly home: string;
  readonly contenedor?: string | undefined;
  readonly capacidades: readonly string[];
}

/** Hechos derivados consolidados del alias. */
export interface HechosDelAlias {
  readonly permisos: PermisosDelAlias;
  readonly cuotas: readonly CuotaDelAlias[];
  readonly arnes: ArnesDelAlias;
  /** Alias alcanzables por ACL. */
  readonly destinos: readonly string[];
}

/** Contexto completo del alias (perfil autorado y hechos derivados). */
export interface ContextoDeAlias {
  readonly perfil: AgentProfile;
  readonly hechos: HechosDelAlias;
}

// ── Composición del bloque de perfil ────────────────────────────────────────

/** Renderiza una lista como viñetas Markdown. */
export function vinetas(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Renderiza una sección Markdown con título y cuerpo, o undefined si el cuerpo está vacío. */
export function seccion(titulo: string, cuerpo: string | undefined): string | undefined {
  if (cuerpo === undefined || cuerpo.trim().length === 0) return undefined;
  return `## ${titulo}\n\n${cuerpo.trim()}`;
}

/** Renderiza el resumen de permisos del alias. */
export function lineasDePermisos(permisos: PermisosDelAlias): string {
  const marca = (concedido: boolean): string => (concedido ? "sí" : "no");
  return [
    `- Rutear mensajes a otros alias: ${marca(permisos.ruta)}`,
    `- Leer el estado de la flota: ${marca(permisos.lectura)}`,
    `- Cambiar configuración (control): ${marca(permisos.control)}`,
    `- Avisar a un humano por notify: ${marca(permisos.notificacion)}`,
  ].join("\n");
}

/** Renderiza las cuotas asociadas al alias. */
export function lineasDeCuotas(cuotas: readonly CuotaDelAlias[]): string | undefined {
  if (cuotas.length === 0) return undefined;
  return cuotas
    .map((cuota) => {
      const limite = cuota.limite === undefined ? "" : ` — ${cuota.limite}`;
      return `- ${cuota.proveedor} / ${cuota.cuenta}${limite}`;
    })
    .join("\n");
}

/** Renderiza la información técnica del arnés y destinos alcanzables. */
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
 * Compone el bloque de perfil consolidado para el arnés en formato Markdown.
 * Si no hay campos autorados, devuelve una cadena vacía.
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
    seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined),
    seccion("Permisos y acceso vía Cauce", lineasDePermisos(hechos.permisos)),
    seccion("Cuotas y límites", lineasDeCuotas(hechos.cuotas)),
    seccion("Herramientas y capacidades", herramientas),
    seccion("Configuración del arnés", lineasDeArnes(hechos)),
    seccion("Instrucciones fijas de funcionamiento",
      perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
  ].filter((parte): parte is string => parte !== undefined);

  const hayAutorado =
    (perfil.purpose ?? null) !== null || (perfil.role_summary ?? null) !== null ||
    (perfil.human_brief ?? null) !== null ||
    perfil.responsibilities.length > 0 || perfil.restrictions.length > 0 ||
    perfil.tools.length > 0 || perfil.operating_rules.length > 0;
  if (!hayAutorado) return "";

  return secciones.join("\n\n");
}

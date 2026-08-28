import { countCodePoints } from './schemas.js';

/**
 * Per-alias profile: types, limits, and validation of an agent's configuration.
 *
 * Two-unit rule:
 * To avoid inconsistencies across layers (PostgreSQL measuring code points and JS/Zod measuring
 * UTF-16 units), lengths are validated against the strictest of the two:
 * `measureStrictestUnits(t) = Math.max(countCodePoints(t), countUtf16Units(t))`.
 */

/** Length in UTF-16 units (`String.length`). */
export function countUtf16Units(text: string): number {
  return text.length;
}

/** Length measured with the strictest unit (max of code points and UTF-16). */
export function measureStrictestUnits(text: string): number {
  return Math.max(countCodePoints(text), countUtf16Units(text));
}

/** Per-field and total length limits for the agent profile. */
export const AGENT_PROFILE_LIMITS = {
  /** Identity and purpose: why this alias exists. */
  purpose: 2_000,
  /** Declared role of the agent. */
  role_summary: 4_000,
  /** Instructions for interacting with the human user. */
  human_brief: 2_000,
  /** Character limit for an individual list entry. */
  item: 1_000,
  /** Maximum number of entries allowed in a list. */
  items: 64,
  /** Cumulative character limit for the full profile. */
  total: 24_000
} as const;

/** Profile lists, in the order they add to the budget and are rendered. */
export const AGENT_PROFILE_LIST_FIELDS = [
  'responsibilities', 'restrictions', 'tools', 'operating_rules'
] as const;

/** Profile free-text fields, in the same order. */
export const AGENT_PROFILE_TEXT_FIELDS = ['purpose', 'role_summary', 'human_brief'] as const;

export type AgentProfileListField = (typeof AGENT_PROFILE_LIST_FIELDS)[number];
export type AgentProfileTextField = (typeof AGENT_PROFILE_TEXT_FIELDS)[number];
export type AgentProfileField = AgentProfileListField | AgentProfileTextField;

/** Authored profile of an alias. */
export interface AgentProfile {
  readonly tenant_id: string;
  readonly alias: string;
  /** Identity and purpose. NULL = undeclared. */
  readonly purpose: string | null;
  /** Declared role. NULL = undeclared. */
  readonly role_summary: string | null;
  /** Instructions for interacting with the human. NULL = undeclared. */
  readonly human_brief: string | null;
  readonly responsibilities: readonly string[];
  readonly restrictions: readonly string[];
  readonly tools: readonly string[];
  readonly operating_rules: readonly string[];
}

/** Validation error on agent profile fields. */
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

/** Normalizes a text field; returns null if empty and validates limits. */
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

/** Normalizes a list by dropping empty entries and validating limits. */
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

/** Computes the total units occupied by the profile. */
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

/** Validates and normalizes an agent profile input. */
export function normalizeAgentProfile(input: Record<string, unknown>): AgentProfile {
  const profile: AgentProfile = {
    tenant_id: requireIdentifier(input.tenant_id, 'tenant_id'),
    alias: requireIdentifier(input.alias, 'alias'),
    purpose: normalizeText(input.purpose, 'purpose'),
    role_summary: normalizeText(input.role_summary, 'role_summary'),
    human_brief: normalizeText(input.human_brief, 'human_brief'),
    responsibilities: normalizeList(input.responsibilities, 'responsibilities'),
    restrictions: normalizeList(input.restrictions, 'restrictions'),
    tools: normalizeList(input.tools, 'tools'),
    operating_rules: normalizeList(input.operating_rules, 'operating_rules')
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

/** Builds an empty profile structure for an alias. */
export function emptyAgentProfile(tenantId: string, alias: string): AgentProfile {
  return {
    tenant_id: tenantId, alias, purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: []
  };
}

/**
 * ── THE DERIVED FACTS ────────────────────────────────────────────────────────────────────────
 *
 * The three faces of the file that are NOT written by hand: permissions, quotas, and harness
 * configuration. They already exist as rows in `memberships`/`role_policies`, along the path
 * `agent_account_bindings` -> `alias_routing_ceiling` -> `provider_accounts` (+ `quota_window_state`)
 * and in `agents` + `harness_definitions`.
 *
 * They live here, and not in `@cauce/adapter-sdk`, for the same reason as `AgentProfile`: `@cauce/store`
 * produces them and `@cauce/adapter-sdk` consumes them, and the two cannot import each other.
 * `@cauce/protocol` is the only one both can see.
 *
 * THEY ARE NOT STORED IN `agent_profiles`, and that is the decision that holds everything together:
 * copying them as authored text would be a second source of truth that silently drifts — revoke the
 * permission in `role_policies` and the container file still claims to hold it. They are read fresh
 * every time the file is generated.
 */

/** EFFECTIVE permissions: the union of what every room the alias belongs to grants. */
export interface PermisosDelAlias {
  readonly ruta: boolean;
  readonly lectura: boolean;
  readonly control: boolean;
  /**
   * Notifying a human requires TWO gates and both are necessary: the role must allow it
   * (`role_policies.allow_notify`) AND at least one approved destination must exist
   * (`egress_destinations.enabled`). With no destinations the answer is NO, even if the role says
   * yes: `notify` is default-deny by list, not by role.
   */
  readonly notificacion: boolean;
}

/** Quotas assigned to the alias for external providers. */
export interface CuotaDelAlias {
  readonly proveedor: string;
  readonly cuenta: string;
  /** Human-readable description of the observed limit. */
  readonly limite?: string | undefined;
}

/** Runtime configuration and harness capabilities. */
export interface ArnesDelAlias {
  readonly harness: string;
  readonly home: string;
  readonly contenedor?: string | undefined;
  readonly capacidades: readonly string[];
}

/** Consolidated derived facts for the alias. */
export interface HechosDelAlias {
  readonly permisos: PermisosDelAlias;
  readonly cuotas: readonly CuotaDelAlias[];
  readonly arnes: ArnesDelAlias;
  /** Aliases reachable via ACL. */
  readonly destinos: readonly string[];
}

/** Full alias context (authored profile and derived facts). */
export interface ContextoDeAlias {
  readonly perfil: AgentProfile;
  readonly hechos: HechosDelAlias;
}

// ── Composing the profile block ────────────────────────────────────────────

/** Renders a list as Markdown bullets. */
export function vinetas(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Renders a Markdown section with title and body, or undefined if the body is empty. */
export function seccion(titulo: string, cuerpo: string | undefined): string | undefined {
  if (cuerpo === undefined || cuerpo.trim().length === 0) return undefined;
  return `## ${titulo}\n\n${cuerpo.trim()}`;
}

/** Renders the alias permission summary. */
export function lineasDePermisos(permisos: PermisosDelAlias): string {
  const marca = (concedido: boolean): string => (concedido ? "sí" : "no");
  return [
    `- Rutear mensajes a otros alias: ${marca(permisos.ruta)}`,
    `- Leer el estado de la flota: ${marca(permisos.lectura)}`,
    `- Cambiar configuración (control): ${marca(permisos.control)}`,
    `- Avisar a un humano por notify: ${marca(permisos.notificacion)}`,
  ].join("\n");
}

/** Renders the quotas associated with the alias. */
export function lineasDeCuotas(cuotas: readonly CuotaDelAlias[]): string | undefined {
  if (cuotas.length === 0) return undefined;
  return cuotas
    .map((cuota) => {
      const limite = cuota.limite === undefined ? "" : ` — ${cuota.limite}`;
      return `- ${cuota.proveedor} / ${cuota.cuenta}${limite}`;
    })
    .join("\n");
}

/** Renders the harness technical info and reachable destinations. */
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
 * Composes the consolidated profile block for the harness in Markdown format.
 * Returns an empty string when no authored fields are present.
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

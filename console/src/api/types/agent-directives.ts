/** Types for the three directive layers of an agent: Layer 1 is `agents.role_brief` (database), Layer 2 is the
 * `CLAUDE.md` / `AGENTS.md` file inside the container, Layer 3 is persisted memory (`~/.claude/projects`,
 * `~/.openclaw/memory`). */

/** A specific `CLAUDE.md` / `AGENTS.md` inside an alias' container. */
export interface AgentDirectiveFile {
  path?: string | null;
  /** `user` = `~/.claude/CLAUDE.md`; `workspace` = `~/CLAUDE.md` or `/workspace/CLAUDE.md`. */
  scope?: 'user' | 'workspace' | (string & {}) | null;
  /** Measured order: Codex applies precedence; Claude only exposes it as load order. */
  precedence?: number | null;
  /** Actual fingerprint to detect duplicate manuals even when the visible text is truncated. */
  sha?: string | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** The file text, if the server publishes it. Without it you can only list, not compare. */
  text?: string | null;
  /** true if the server truncated the text: what you see is NOT the whole file. */
  truncated?: boolean | null;
  error?:
    | 'permission_denied' | 'invalid_path' | 'symlink_detected' | 'too_large'
    | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown' | (string & {}) | null;
  reason?: string | null;
}

/** An agent's memory index (file metadata, no content). */
interface AgentMemoryIndexAvailable {
  root?: string | null;
  /** Exact total; null means only `observed_at_least` is known. */
  total?: number | null;
  /** Lower bound observed when the scan hit its cap. */
  observed_at_least?: number | null;
  truncated?: boolean | null;
  entries?: {
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }[] | null;
  error?: never;
  reason?: never;
}

interface AgentMemoryIndexUnavailable {
  root?: string | null;
  total?: null;
  observed_at_least?: null;
  truncated?: null;
  entries?: null;
  error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';
  reason: string;
}

/** `error` discriminates a failed measurement; newer gateways do not hide it as `null`. */
type AgentMemoryIndex = AgentMemoryIndexAvailable | AgentMemoryIndexUnavailable;

/** An agent's governance files: document inventory and content. */

export type AgentDocumentKind =
  | 'directive' | 'tools' | 'prompts' | 'mcp' | 'identity' | 'human'
  | 'memory' | 'heartbeat' | 'configuration';

export interface AgentDocumentItem {
  kind: AgentDocumentKind;
  category?: 'manual' | 'profile' | 'configuration' | 'memory';
  label: string;
  path: string;
  format: string;
  /**
   * true = the server allows GET of content for this row. It is independent from `editable`: a project manual or a
   * profile file may be opened in a viewer without allowing PUT. Absent is treated as false to fail closed during a
   * staged rollout.
   */
  readable?: boolean;
  editable: boolean;
  reason?: string;
  warning?: string;
  projected_fields?: string[] | null;
}

export interface AgentDocumentsMap {
  /** false = this gateway does not publish the route. It is NOT "this agent has no files". */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  facts_source?: 'measured' | 'registry' | 'database';
  harness?: string;
  home?: string | null;
  /** Top-of-list notice when the source is not a measurement. */
  caveat?: string;
  items?: AgentDocumentItem[];
}

export interface AgentDocumentContent {
  tenant_id: string;
  alias: string;
  kind: AgentDocumentKind;
  path: string;
  format: string;
  /** false = the file does not yet exist. It can be created; it is NOT the same as being empty. */
  exists: boolean;
  content: string;
  /** Fingerprint of what was served. It is returned on save so two people do not silently overwrite each other. */
  sha: string | null;
  bytes: number;
  editable: boolean;
  /** A truncated prefix can be inspected, but never edited nor replaced. */
  truncated: boolean;
  modified_at?: string;
  /** true = what you see is a PROJECTION, not the whole file. */
  projected: boolean;
  warning?: string;
}

export interface AgentDocumentGuardado {
  /*
   * They are all optional on purpose: `request<T>` only types TypeScript, it does not validate the JSON from an older
   * gateway during a staged rollout. The UI uses a type guard and only clears the draft when ALL of them accredit
   * application.
   */
  ok?: boolean;
  state?: string;
  evidence?: string;
  path?: string;
  sha?: string;
  bytes?: number;
}

export interface AgentDirective {
  /**
   * false = this gateway does not publish the endpoint. It does NOT mean "the agent has no files": it means nobody
   * looked. The screen has to say one thing and not the other.
   */
  publicado: boolean;
  /** Indicates whether the server obtained measured facts from the container instead of inferred paths. */
  medido?: boolean;
  /** Why it could not be read, when `publicado` is false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  manual_order?: 'codex_precedence' | 'claude_load_order' | 'workspace_only' | (string & {}) | null;
  context_coverage?: 'standard_manuals' | (string & {}) | null;
  context_limitations?: string[] | null;
  memory?: AgentMemoryIndex | null;
}

// ------------------------------------------------------------------------------------------
// Change history of the declared role
// ------------------------------------------------------------------------------------------

/** A log entry: a concrete change to an alias' declared role. */
export interface RoleBriefHistoryEntry {
  id?: string | null;
  tenant_id?: string | null;
  alias?: string | null;
  /** `update`, `insert`, `delete`… whatever the trigger declares. The value set is not assumed. */
  operation?: string | null;
  /** The text that existed BEFORE. `null` = there was no role (creation), which is not the same as an empty string. */
  previous_brief?: string | null;
  /** The text that remained AFTER. `null` = the role was deleted. */
  new_brief?: string | null;
  previous_template_slug?: string | null;
  new_template_slug?: string | null;
  actor_tenant?: string | null;
  actor_alias?: string | null;
  changed_at?: string | null;
}

export interface RoleBriefHistory {
  /**
   * false = this gateway does not publish the log. It does NOT mean "this alias never changed role". Same criterion
   * as `AgentDirective.publicado`, and for the same reason: a negative that nobody measured is not a fact about the
   * system.
   */
  publicado: boolean;
  /** Why it could not be read, when `publicado` is false. */
  motivo?: string;
  observed_at?: string | null;
  /**
   * The entries as sent by the server, WITHOUT ordering them here. The order is decided in `historial-rol.ts`, where
   * it can be tested: see `entradasMasNuevasPrimero`.
   */
  entries?: RoleBriefHistoryEntry[] | null;
}

/**
 * THE PROFILE AND ITS PREVIEW (`GET /v3/console/tenants/:tenantId/agents/:alias/perfil`).
 *
 * `ficheros` is the EXACT TEXT that will remain in each file read by that alias' harness, composed by the SAME
 * function the adapter uses to write it inside the container. Having both come from the same function is what
 * prevents the preview from lying: two implementations of the same text diverge at the first correction and the
 * operator would approve a different block from the one that ends up on disk, without anything erroring.
 */
export interface AgentPerfilCampos {
  purpose: string;
  role_summary: string;
  human_brief: string;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
}

/** Canonical form persisted by the gateway; an empty text is represented as `null`. */
export interface AgentPerfilValor {
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
}

interface AgentPerfilFichero {
  nombre: string;
  /** `solo-si-falta` = it belongs to the agent (MEMORY.md, HEARTBEAT.md): if it exists it is NOT touched. */
  politica: 'bloque-gestionado' | 'solo-si-falta';
  texto: string;
  unidades: number;
}

export interface AgentPerfil {
  /**
   * false = this gateway does not publish the route. It does NOT mean "this alias has no profile": it means nobody
   * looked. Same criterion as `AgentDirective.publicado`, and for the same reason — a negative that nobody measured
   * is not a fact about the system.
   */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  /** Durable state of the alias. Absent is treated as off, never as implicitly enabled. */
  agent_enabled?: boolean;
  /** ACTUAL presence of `agent_profiles`; a persisted empty profile is still `true`. */
  exists?: boolean;
  /** Profile's own desired revision; `null` when there is still no row. */
  revision?: number | null;
  /** Latest revision whose full batch was accredited by the runtime. */
  applied_revision?: number | null;
  /** Desired/applied state computed by the gateway, not inferred by the browser. */
  runtime_state?:
    | 'absent' | 'pending' | 'pending_session_refresh' | 'applied' | 'disabled'
    | 'drifted' | 'runtime_unverified';
  /** Live evidence of path+SHA+generation; without it the UI never claims application. */
  runtime_verification?: {
    state: 'current' | 'drifted' | 'unverified';
    generation: string | null;
    container_id: string | null;
    observed_at: string | null;
    reason?: string;
    documents: {
      name: string;
      path: string;
      expected_sha: string;
      observed_sha: string | null;
      expected_bytes: number;
      observed_bytes: number | null;
      current: boolean;
    }[];
  } | null;
  runtime_adoption?: {
    evidence: 'adapter_delivery';
    revision: number;
    generation: string;
    adopted_at: string;
    documents: { name: string; path: string; sha: string }[];
  } | null;
  runtime_reason?: string;
  /** Harness declared by the facts. `null` when the registry declares none. */
  harness?: string | null;
  perfil: AgentPerfilValor;
  hechos?: {
    permisos: { ruta: boolean; lectura: boolean; control: boolean; notificacion: boolean };
    cuotas: { proveedor: string; cuenta: string; limite?: string }[];
    arnes: { harness: string; home: string; contenedor?: string; capacidades: string[] };
    destinos: string[];
  };
  limites?: {
    purpose: number;
    role_summary: number;
    item: number;
    items: number;
    total: number;
  };
  medida?: { unidades: number; tope: number };
  /**
   * What the preview was composed from. `fichero-vacio` means the server did NOT read the container's disk: whatever
   * a person wrote by hand is still there and is not touched —the merge preserves the outside byte for byte—,
   * but this response has not seen it and cannot show it.
   */
  base?: 'fichero-vacio' | 'runtime-medido';
  ficheros?: AgentPerfilFichero[];
  /** Why there are no files, when there are none. An empty array without explanation reads poorly. */
  aviso?: string;
}

interface AgentPerfilRuntimeAck {
  name: string;
  path: string;
  state: 'written' | 'already_current' | 'preserved';
  sha: string;
  bytes: number;
  generation: string;
  container_id: string | null;
}

/** Response that allows claiming desired and runtime converged on the same revision. */
export interface AgentPerfilAplicado {
  ok: true;
  state: 'applied';
  tenant_id: string;
  alias: string;
  revision: number;
  applied_revision: number;
  acknowledgements: AgentPerfilRuntimeAck[];
  runtime_adoption: {
    evidence: 'adapter_delivery';
    revision: number;
    generation: string;
    adopted_at: string;
    documents: { name: string; path: string; sha: string }[];
  };
}

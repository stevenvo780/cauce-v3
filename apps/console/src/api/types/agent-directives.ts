/**
 * Tipos para las tres capas de directiva de un agente:
 * Capa 1: agents.role_brief (base de datos)
 * Capa 2: CLAUDE.md / AGENTS.md (fichero en contenedor)
 * Capa 3: Memoria persistida (~/.claude/projects, ~/.openclaw/memory)
 */

/** Un `CLAUDE.md` / `AGENTS.md` concreto dentro del contenedor de un alias. */
export interface AgentDirectiveFile {
  path?: string | null;
  /** `user` = `~/.claude/CLAUDE.md`; `workspace` = `~/CLAUDE.md` o `/workspace/CLAUDE.md`. */
  scope?: 'user' | 'workspace' | string | null;
  /** Orden medido: Codex aplica precedencia; Claude lo expone sólo como orden de carga. */
  precedence?: number | null;
  /** Huella real para detectar manuales duplicados aunque el texto visible esté truncado. */
  sha?: string | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** El texto del fichero, si el servidor lo publica. Sin él sólo se puede listar, no cotejar. */
  text?: string | null;
  /** true si el servidor recortó el texto: lo que se ve NO es el fichero entero. */
  truncated?: boolean | null;
  error?:
    | 'permission_denied' | 'invalid_path' | 'symlink_detected' | 'too_large'
    | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown' | string | null;
  reason?: string | null;
}

/** El índice de la memoria de un agente (metadatos de ficheros sin contenido). */
export interface AgentMemoryIndexAvailable {
  root?: string | null;
  /** Total exacto; null significa que sólo se conoce `observed_at_least`. */
  total?: number | null;
  /** Límite inferior observado cuando el barrido alcanzó su cap. */
  observed_at_least?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
  error?: never;
  reason?: never;
}

export interface AgentMemoryIndexUnavailable {
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

/** `error` discrimina una medición fallida; los gateways nuevos no la esconden como `null`. */
export type AgentMemoryIndex = AgentMemoryIndexAvailable | AgentMemoryIndexUnavailable;

/**
 * Ficheros de gobierno de un agente: inventario y contenido de documentos.
 */

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
   * true = el servidor admite GET de contenido para esta fila. Es independiente de `editable`:
   * un manual de proyecto o un fichero de perfil puede abrirse en visor sin admitir PUT.
   * Ausente se trata como false para fallar cerrado durante un despliegue escalonado.
   */
  readable?: boolean;
  editable: boolean;
  reason?: string;
  warning?: string;
  projected_fields?: string[] | null;
}

export interface AgentDocumentsMap {
  /** false = este gateway no publica la ruta. NO es «este agente no tiene ficheros». */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  facts_source?: 'measured' | 'registry' | 'database';
  harness?: string;
  home?: string | null;
  /** Aviso de arriba del todo cuando la fuente no es una medición. */
  caveat?: string;
  items?: AgentDocumentItem[];
}

export interface AgentDocumentContent {
  tenant_id: string;
  alias: string;
  kind: AgentDocumentKind;
  path: string;
  format: string;
  /** false = el fichero todavía no existe. Se puede crear; NO es lo mismo que estar vacío. */
  exists: boolean;
  content: string;
  /** Huella de lo servido. Se devuelve al guardar para que dos personas no se pisen en silencio. */
  sha: string | null;
  bytes: number;
  editable: boolean;
  /** Un prefijo recortado se puede inspeccionar, pero nunca editar ni reemplazar. */
  truncated: boolean;
  modified_at?: string;
  /** true = lo que se ve es una PROYECCIÓN, no el fichero entero. */
  projected: boolean;
  warning?: string;
}

export interface AgentDocumentGuardado {
  /*
   * Todos son opcionales a propósito: `request<T>` sólo tipa TypeScript, no valida el JSON de un
   * gateway anterior durante un despliegue escalonado. La UI usa un type guard y sólo limpia el
   * borrador cuando TODOS acreditan aplicación.
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
   * false = este gateway no publica el endpoint. NO significa «el agente no tiene ficheros»:
   * significa que no se miró. La pantalla tiene que decir una cosa y no la otra.
   */
  publicado: boolean;
  /**
   * Indica si el servidor obtuvo hechos medidos del contenedor en vez de rutas inferidas.
   */
  medido?: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  manual_order?: 'codex_precedence' | 'claude_load_order' | 'workspace_only' | string | null;
  context_coverage?: 'standard_manuals' | string | null;
  context_limitations?: string[] | null;
  memory?: AgentMemoryIndex | null;
}

// ------------------------------------------------------------------------------------------
// Historial de cambios del rol declarado
// ------------------------------------------------------------------------------------------

/** Una entrada del diario: un cambio concreto del rol declarado de un alias. */
export interface RoleBriefHistoryEntry {
  id?: string | null;
  tenant_id?: string | null;
  alias?: string | null;
  /** `update`, `insert`, `delete`… lo que declare el trigger. No se asume el juego de valores. */
  operation?: string | null;
  /** El texto que había ANTES. `null` = no había rol (alta), que no es lo mismo que cadena vacía. */
  previous_brief?: string | null;
  /** El texto que quedó DESPUÉS. `null` = se borró el rol. */
  new_brief?: string | null;
  previous_template_slug?: string | null;
  new_template_slug?: string | null;
  actor_tenant?: string | null;
  actor_alias?: string | null;
  changed_at?: string | null;
}

export interface RoleBriefHistory {
  /**
   * false = este gateway no publica el diario. NO significa «este alias nunca cambió de rol».
   * Mismo criterio que `AgentDirective.publicado`, y por la misma razón: un negativo que nadie
   * midió no es un hecho del sistema.
   */
  publicado: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  /**
   * Las entradas tal como las mandó el servidor, SIN ordenar acá. El orden se decide en
   * `historial-rol.ts`, que es donde se puede probar: ver `entradasMasNuevasPrimero`.
   */
  entries?: RoleBriefHistoryEntry[] | null;
}

/**
 * EL PERFIL Y SU VISTA PREVIA
 * (`GET /v3/console/tenants/:tenantId/agents/:alias/perfil`).
 *
 * `ficheros` es EL TEXTO EXACTO que va a quedar en cada fichero que el arnés de ese alias lee,
 * compuesto por la MISMA función que usa el adaptador para escribirlo dentro del contenedor. Que
 * salgan de la misma función es lo que impide que la vista previa mienta: dos implementaciones del
 * mismo texto divergen a la primera corrección y el operador aprobaría un bloque distinto del que
 * acaba en el disco, sin que nada diera error.
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

/** Forma canónica que persiste el gateway; un texto vacío se representa como `null`. */
export interface AgentPerfilValor {
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
}

export interface AgentPerfilFichero {
  nombre: string;
  /** `solo-si-falta` = es del agente (MEMORY.md, HEARTBEAT.md): si existe NO se toca. */
  politica: 'bloque-gestionado' | 'solo-si-falta';
  texto: string;
  unidades: number;
}

export interface AgentPerfil {
  /**
   * false = este gateway no publica la ruta. NO significa «este alias no tiene perfil»: significa
   * que no se miró. Mismo criterio que `AgentDirective.publicado`, y por la misma razón — un
   * negativo que nadie midió no es un hecho del sistema.
   */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  /** Estado durable del alias. Ausente se trata como apagado, nunca como habilitado implícito. */
  agent_enabled?: boolean;
  /** Presencia REAL de `agent_profiles`; un perfil persistido vacío sigue siendo `true`. */
  exists?: boolean;
  /** Revisión desired propia del perfil; `null` cuando todavía no existe una fila. */
  revision?: number | null;
  /** Última revisión cuyo lote completo fue acreditado por el runtime. */
  applied_revision?: number | null;
  /** Estado desired/applied calculado por el gateway, no inferido por el navegador. */
  runtime_state?:
    | 'absent' | 'pending' | 'pending_session_refresh' | 'applied' | 'disabled'
    | 'drifted' | 'runtime_unverified';
  /** Evidencia viva de ruta+SHA+generación; sin ella la UI nunca afirma aplicación. */
  runtime_verification?: {
    state: 'current' | 'drifted' | 'unverified';
    generation: string | null;
    container_id: string | null;
    observed_at: string | null;
    reason?: string;
    documents: Array<{
      name: string;
      path: string;
      expected_sha: string;
      observed_sha: string | null;
      expected_bytes: number;
      observed_bytes: number | null;
      current: boolean;
    }>;
  } | null;
  runtime_adoption?: {
    evidence: 'adapter_delivery';
    revision: number;
    generation: string;
    adopted_at: string;
    documents: Array<{ name: string; path: string; sha: string }>;
  } | null;
  runtime_reason?: string;
  /** El arnés declarado en los hechos. `null` cuando el registro no dice ninguno. */
  harness?: string | null;
  perfil: AgentPerfilValor;
  hechos?: {
    permisos: { ruta: boolean; lectura: boolean; control: boolean; notificacion: boolean };
    cuotas: Array<{ proveedor: string; cuenta: string; limite?: string }>;
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
   * De qué se compuso la vista previa. `fichero-vacio` significa que el servidor NO leyó el disco
   * del contenedor: lo que una persona haya escrito a mano sigue ahí y no se toca —la fusión
   * conserva lo de fuera byte a byte—, pero esta respuesta no lo ha visto y no puede enseñarlo.
   */
  base?: 'fichero-vacio' | 'runtime-medido';
  ficheros?: AgentPerfilFichero[];
  /** Por qué no hay ficheros, cuando no los hay. Un array vacío sin explicación se lee mal. */
  aviso?: string;
}

export interface AgentPerfilRuntimeAck {
  name: string;
  path: string;
  state: 'written' | 'already_current' | 'preserved';
  sha: string;
  bytes: number;
  generation: string;
  container_id: string | null;
}

/** Respuesta que permite afirmar que desired y runtime convergieron en la misma revisión. */
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
    documents: Array<{ name: string; path: string; sha: string }>;
  };
}

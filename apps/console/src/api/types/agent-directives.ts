// ------------------------------------------------------------------------------------------
// LAS TRES CAPAS DE DIRECTIVA DE UN AGENTE
//
// Medido sobre producción el 23-ago-2026 (/workspace/DISENO-TRES-CAPAS-DE-DIRECTIVA.md): lo que
// gobierna a un alias no vive en un sitio, vive en tres, y la consola sólo veía uno.
//
//   Capa 1 · `agents.role_brief` — QUIÉN SOS y QUÉ PODÉS DECIDIR. Está en la base, viaja en cada
//            entrega, y es la única que la consola ya sabía editar. Llega por `/v3/console/config`.
//   Capa 2 · `CLAUDE.md` / `AGENTS.md` — CÓMO SE TRABAJA AQUÍ. Es un FICHERO dentro del
//            contenedor del alias, en dos niveles posibles (usuario y espacio de trabajo). Hoy
//            sólo se toca por `docker exec`, que es exactamente por lo que nadie lo mantiene:
//            janus tiene DOS a la vez y gaia no tiene NINGUNO.
//   Capa 3 · La memoria — LO QUE ESE AGENTE APRENDIÓ. `~/.claude/projects`, `~/.openclaw/memory`.
//            zeus tiene 18.212 ficheros ahí y gaia 2, y nadie lo ve desde el panel.
//
// Las capas 2 y 3 son ficheros de un contenedor, no filas de la base: el gateway tiene que
// publicarlas. Estos tipos son el contrato con el que la consola las va a leer; mientras el
// gateway no lo sirva, `getAgentDirective` devuelve `publicado: false` y la pantalla lo DICE con
// esas palabras, en vez de pintar «sin CLAUDE.md» sobre una lectura que nunca ocurrió.
// ------------------------------------------------------------------------------------------

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

/** El índice de la memoria de un agente. Índice, no contenido: es lo que pidió Steven. */
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

// ------------------------------------------------------------------------------------------
// LOS FICHEROS QUE GOBIERNAN A UN AGENTE
//
// `GET /v3/console/tenants/:tenantId/agents/:alias/documents` da el INVENTARIO
// (qué fichero es cuál y dónde vive)
// y `.../documents/:kind/content` da y recibe el CONTENIDO.
//
// La honestidad de esta pantalla depende de leer bien tres campos, porque los tres significan
// cosas distintas y los tres se parecen a «no se puede»:
//
//   `facts_source`   de dónde salió la RUTA. Sólo `measured` es de fiar; el registro se equivocaba
//                    de arnés en 5 de los 14 alias, así que con cualquier otro valor la ruta es
//                    una pista y no un hecho, y no se sirve contenido.
//   `editable`       el fichero ENTERO se puede escribir.
//   `projected_fields` el fichero entero NO sale nunca, pero estos campos suyos sí. Es el caso de
//                    `openclaw.json`, que lleva `auth` y `secrets` en el mismo documento.
//
// Un documento sin `editable` y sin `projected_fields` es de sólo lectura, y `reason` dice por
// qué CON PALABRAS, que es lo que pidió Steven: un hueco explicado vale más que un botón muerto.
// ------------------------------------------------------------------------------------------

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
   * ¿El servidor MIDIÓ de verdad el contenedor? `publicado: true` sólo dice que la ruta existe;
   * puede contestar 200 sin haber mirado nada (sin hechos de entorno, o con rutas deducidas del
   * registro, que falla en 5 de 14 alias). Sin este campo la consola no puede distinguir «no hay
   * fichero» de «no se miró», y llegó a afirmar lo primero cuando pasaba lo segundo.
   * Los gateways anteriores no lo mandan: ahí vale la regla del `null` en `files`/`memory`.
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
  /** Quién lo cambió. Hoy llega NULL por todos los caminos: ver el comentario de arriba. */
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

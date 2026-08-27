import { FICHEROS_OPENCLAW } from '@cauce/protocol';

/** Arnés en ejecución deducido del entorno medido. */
export type HarnessKind = 'claude' | 'codex' | 'openclaw' | 'hermes' | 'unknown';

export type DocumentKind =
  | 'directive' | 'tools' | 'prompts' | 'mcp' | 'identity' | 'human'
  | 'memory' | 'heartbeat' | 'configuration';

/** Categoría funcional del documento de gobierno. */
export type DocumentCategory = 'manual' | 'profile' | 'configuration' | 'memory';

export type DocumentFormat = 'markdown' | 'json' | 'toml' | 'json-fragment';

/**
 * Hechos del entorno de ejecución observados dentro del contenedor del agente,
 * necesarios para resolver rutas canónicas de gobierno.
 */
export interface RuntimeFacts {
  /** Deducido del binario en ejecución: `bin/claude.js` -> 'claude', etc. */
  readonly harness: HarnessKind;
  /** `HOME` del proceso del arnés. */
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR` si está puesto. */
  readonly claudeConfigDir?: string;
  /** `CODEX_HOME` si está puesto. */
  readonly codexHome?: string;
  /** `cwd` del proceso: de ahí salen los CLAUDE.md/AGENTS.md de nivel proyecto. */
  readonly cwd?: string;
  /** Raíz explícita del workspace compartido; nunca se descubre caminando hacia `/`. */
  readonly workspaceRoot?: string;
  /** Raíz de proyecto acreditada por un marcador real dentro del workspace (p. ej. `.git`). */
  readonly projectRoot?: string;
  /** Proyección no sensible de config.toml; sólo válida para Codex. */
  readonly projectDocMaxBytes?: number;
  /** Basenames de fallback medidos, nunca rutas ni el resto de config.toml. */
  readonly projectDocFallbackFilenames?: readonly string[];
  /** Workspace efectivo de OpenClaw; no se deduce de HOME ni de openclaw.json. */
  readonly openclawWorkspace?: string;
  /** Generación opaca del contenedor que midió estos hechos. Obligatoria para acreditar escritura. */
  readonly generation?: string;
  /** Contenedor que publicó la medición; evidencia, nunca se deriva del registro SQL. */
  readonly containerId?: string;
  /** Capacidades de terminal publicadas por ese mismo proceso. */
  readonly modes?: readonly string[];
}
export interface AgentDocument {
  readonly kind: DocumentKind;
  readonly category: DocumentCategory;
  /** Rótulo descriptivo del documento para la interfaz de consola. */
  readonly label: string;
  /** Ruta absoluta dentro del contenedor del agente. */
  readonly path: string;
  readonly format: DocumentFormat;
  /** `true` sólo si esta vía puede escribirlo con seguridad. */
  readonly editable: boolean;
  /** Motivo por el cual no se puede editar el documento. */
  readonly reason?: string;
  /** Advertencia a mostrar antes de confirmar la escritura. */
  readonly warning?: string;
}

/**
 * Nombres de fichero que no se leen ni se escriben JAMÁS por esta vía, esté donde esté el fichero.
 * Se comprueba por nombre base y además por ruta ya resuelta (`realpath`), porque en `ctrl-infra`
 * el `.credentials.json` es un bind-mount de UN SOLO FICHERO metido dentro de un `.claude` que por
 * lo demás es propio: mirar sólo el directorio no lo salvaría.
 */
export const NEVER_SERVE_BASENAMES: readonly string[] = [
  '.credentials.json',
  'auth.json',
  '.claude.json',
  'openclaw.json',
  '.env',
  '.netrc',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
  'authorized_keys',
];

export const NEVER_SERVE_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx'];

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function claudeDir(facts: RuntimeFacts): string {
  return facts.claudeConfigDir?.trim() || join(facts.home, '.claude');
}

function codexDir(facts: RuntimeFacts): string {
  return facts.codexHome?.trim() || join(facts.home, '.codex');
}

/** Raíz de memoria para cada arnés, derivada de los overrides medidos dentro del proceso. */
export function memoryRootForHarness(facts: RuntimeFacts): string | null {
  const home = facts.home.replace(/\/+$/, '');
  switch (facts.harness) {
    case 'claude':
      return `${(facts.claudeConfigDir?.trim() || `${home}/.claude`).replace(/\/+$/, '')}/projects`;
    case 'codex':
      return `${(facts.codexHome?.trim() || `${home}/.codex`).replace(/\/+$/, '')}/memories`;
    case 'openclaw': {
      const workspace = facts.openclawWorkspace?.trim().replace(/\/+$/, '');
      return workspace?.startsWith('/') ? `${workspace}/memory` : null;
    }
    default:
      return null;
  }
}

/** Juego cerrado de ficheros de PERFIL, separado del inventario de configuración sensible. */
export function profileDocumentPaths(facts: RuntimeFacts): readonly string[] {
  if (!facts.home.startsWith('/')) return [];
  if (facts.harness === 'claude') return [join(claudeDir(facts), 'CLAUDE.md')];
  if (facts.harness === 'codex') return [join(codexDir(facts), 'AGENTS.md')];
  if (facts.harness === 'hermes') return [join(facts.home, 'AGENTS.md')];
  if (facts.harness === 'openclaw') {
    const workspace = facts.openclawWorkspace?.trim();
    if (workspace === undefined || !workspace.startsWith('/')) return [];
    return FICHEROS_OPENCLAW.map((name) => join(workspace, name));
  }
  return [];
}

export interface EffectiveManualPath {
  readonly path: string;
  readonly scope: 'user' | 'workspace';
  /** Menor primero. En Claude describe carga; en Codex los posteriores tienen mayor precedencia. */
  readonly precedence: number;
  /** Candidatos del mismo grupo se prueban en orden y sólo carga el primero que existe. */
  readonly selection: 'all' | 'first_existing';
  readonly group: string;
}

/** Valor que Codex aplica cuando config.toml no lo cambia. */
export const DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

function validCodexFallbackBasename(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\')
    && !value.includes('\0') && !value.includes('..')
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    && !NEVER_SERVE_BASENAMES.includes(normalized)
    && !NEVER_SERVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export interface CodexProjectDocumentConfig {
  readonly maxBytes: number;
  readonly fallbackFilenames: readonly string[];
}

/**
 * Los dos knobs forman una sola proyección acreditada. Un agente viejo no manda ninguno y uno
 * parcialmente actualizado podría mandar sólo uno: en ambos casos se usan los defaults, nunca
 * una mezcla que Codex no aplicó. La validación se repite en relay y gateway porque la presencia
 * es autenticada pero no confiable a ciegas.
 */
export function measuredCodexProjectDocumentConfig(
  facts: RuntimeFacts,
): CodexProjectDocumentConfig | undefined {
  const maxBytes = facts.projectDocMaxBytes;
  const rawFallbacks = facts.projectDocFallbackFilenames;
  if (facts.harness !== 'codex' || !Number.isSafeInteger(maxBytes)
      || (maxBytes ?? 0) < 1 || (maxBytes ?? 0) > 16 * 1024 * 1024
      || !Array.isArray(rawFallbacks) || rawFallbacks.length > 16) return undefined;
  const seen = new Set<string>(['AGENTS.override.md', 'AGENTS.md']);
  const fallbackFilenames: string[] = [];
  for (const value of rawFallbacks) {
    if (typeof value !== 'string' || !validCodexFallbackBasename(value) || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    fallbackFilenames.push(value);
  }
  return { maxBytes: maxBytes!, fallbackFilenames };
}

export function codexProjectDocMaxBytes(facts: RuntimeFacts): number {
  return measuredCodexProjectDocumentConfig(facts)?.maxBytes
    ?? DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES;
}

export function codexFallbackFilenames(facts: RuntimeFacts): readonly string[] {
  return measuredCodexProjectDocumentConfig(facts)?.fallbackFilenames ?? [];
}

function canonicalContextDirectory(value: string): boolean {
  if (!value.startsWith('/') || value === '/' || value.length > 4096 || value.includes('\0')) return false;
  const segments = value.split('/');
  return !segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

/**
 * Juego cerrado y ordenado de manuales que el proceso realmente aplica.
 *
 * La capa global va primero. Con `projectRoot` acreditado se añaden todos los niveles desde esa
 * raíz hasta cwd; sin raíz sólo se añade el fichero exacto de cwd, que sí fue medido, y nunca se
 * sube buscando `.git` ni otro marcador plausible. OpenClaw conserva exclusivamente el AGENTS.md
 * de su workspace medido. Una misma ruta se devuelve una vez, en su primera posición efectiva.
 */
export function effectiveManualPaths(facts: RuntimeFacts): readonly EffectiveManualPath[] {
  if (!facts.home.startsWith('/')) return [];
  const candidates: Array<Omit<EffectiveManualPath, 'precedence'>> = [];
  if (facts.harness === 'claude') {
    candidates.push({
      path: join(claudeDir(facts), 'CLAUDE.md'), scope: 'user', selection: 'all', group: 'user',
    });
  } else if (facts.harness === 'codex') {
    const dir = codexDir(facts);
    candidates.push(
      { path: join(dir, 'AGENTS.override.md'), scope: 'user', selection: 'first_existing', group: 'user' },
      { path: join(dir, 'AGENTS.md'), scope: 'user', selection: 'first_existing', group: 'user' },
    );
  } else if (facts.harness === 'hermes') {
    candidates.push({
      path: join(facts.home, 'AGENTS.md'), scope: 'user', selection: 'all', group: 'user',
    });
  } else if (facts.harness === 'openclaw') {
    const workspace = facts.openclawWorkspace?.trim();
    if (workspace !== undefined && canonicalContextDirectory(workspace)) {
      candidates.push({
        path: join(workspace, 'AGENTS.md'), scope: 'workspace', selection: 'all', group: 'workspace',
      });
    }
  } else {
    return [];
  }

  if (facts.harness === 'claude' || facts.harness === 'codex') {
    const cwd = facts.cwd;
    // El contrato auditado parte de la raíz de proyecto real para ambos arneses. El mount puede
    // contener varios repositorios y su CLAUDE.md no gobierna necesariamente el proceso actual.
    const root = facts.projectRoot;
    if (cwd !== undefined && canonicalContextDirectory(cwd)) {
      let directories: string[] = [];
      if (root === undefined) {
        // Sin raíz acreditada, un único nivel exacto. No se inventa jerarquía.
        directories = [cwd];
      } else if (canonicalContextDirectory(root)
          && (cwd === root || cwd.startsWith(`${root}/`))) {
        const relative = cwd === root ? [] : cwd.slice(root.length + 1).split('/');
        if (relative.length <= 64) {
          directories = [root];
          let current = root;
          for (const segment of relative) {
            current = join(current, segment);
            directories.push(current);
          }
        }
      }
      for (const [level, directory] of directories.entries()) {
        const group = `workspace:${level}`;
        if (facts.harness === 'claude') {
          candidates.push(
            { path: join(directory, 'CLAUDE.md'), scope: 'workspace', selection: 'all', group },
            {
              path: join(join(directory, '.claude'), 'CLAUDE.md'), scope: 'workspace',
              selection: 'all', group,
            },
            { path: join(directory, 'CLAUDE.local.md'), scope: 'workspace', selection: 'all', group },
          );
        } else {
          candidates.push(
            {
              path: join(directory, 'AGENTS.override.md'), scope: 'workspace',
              selection: 'first_existing', group,
            },
            {
              path: join(directory, 'AGENTS.md'), scope: 'workspace',
              selection: 'first_existing', group,
            },
            ...codexFallbackFilenames(facts).map((name) => ({
              path: join(directory, name), scope: 'workspace' as const,
              selection: 'first_existing' as const, group,
            })),
          );
        }
      }
    }
  }

  const seen = new Set<string>();
  const result: EffectiveManualPath[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    result.push({ ...candidate, precedence: result.length });
  }
  return result;
}

/**
 * `settings.json` de Claude puede contener `hooks`: órdenes que el arnés ejecuta automáticamente.
 * Se emite una advertencia al operador antes de guardar cambios en este documento.
 */
const AVISO_HOOKS =
  'Este fichero puede contener `hooks`: órdenes que el arnés ejecuta solo. ' +
  'Cambiarlo equivale a ejecutar código dentro del contenedor del agente.';

const RAZON_CONFIG_TOML =
  'Es el mismo fichero que la configuración de MCP y de modelo, y un TOML mal formado deja al ' +
  'agente sin arrancar. De sólo lectura hasta que haya validación previa.';

const RAZON_OPENCLAW =
  'En openclaw las herramientas, las skills, los prompts y los MCP viven en `openclaw.json`, el ' +
  'mismo documento que `auth` y `secrets`. No se sirve entero: hay que proyectar campo a campo.';

/**
 * Resuelve el juego CERRADO de documentos de un alias. Cerrado a propósito: la ruta nunca viene
 * del navegador, se deriva aquí de hechos medidos. El navegador manda un `kind`, no un `path`.
 */
export function resolveAgentDocuments(facts: RuntimeFacts): AgentDocument[] {
  if (!facts.home.startsWith('/')) return [];

  switch (facts.harness) {
    case 'claude': {
      const dir = claudeDir(facts);
      return [
        {
          kind: 'directive',
          category: 'manual',
          label: 'CLAUDE.md (manual del sitio)',
          path: join(dir, 'CLAUDE.md'),
          format: 'markdown',
          editable: true,
        },
        {
          kind: 'tools',
          category: 'configuration',
          label: 'Herramientas y permisos (settings.json)',
          path: join(dir, 'settings.json'),
          format: 'json',
          editable: false,
          reason: 'Este canal sólo admite los manuales CLAUDE.md/AGENTS.md. settings.json puede '
            + 'contener hooks ejecutables y necesita validación estructural antes de habilitar escritura.',
          warning: AVISO_HOOKS,
        },
        {
          kind: 'prompts',
          category: 'configuration',
          label: 'Subagentes (~/.claude/agents)',
          path: join(dir, 'agents'),
          format: 'markdown',
          editable: false,
          reason: 'Es un directorio; v1 sólo lista lo que hay, no edita fichero a fichero.',
        },
        {
          kind: 'mcp',
          category: 'configuration',
          label: 'Servidores MCP',
          path: join(facts.home, '.claude.json'),
          format: 'json',
          editable: false,
          reason:
            'Los MCP viven en `.claude.json`, junto al OAuth de la cuenta y al historial de todos ' +
            'los proyectos. No se sirve: habría que proyectar sólo `mcpServers`.',
        },
      ];
    }
    case 'codex': {
      const dir = codexDir(facts);
      return [
        {
          kind: 'directive',
          category: 'manual',
          label: 'AGENTS.md (manual del sitio)',
          path: join(dir, 'AGENTS.md'),
          format: 'markdown',
          editable: true,
        },
        {
          kind: 'tools',
          category: 'configuration',
          label: 'Herramientas y MCP (config.toml)',
          path: join(dir, 'config.toml'),
          format: 'toml',
          editable: false,
          reason: RAZON_CONFIG_TOML,
        },
        {
          kind: 'prompts',
          category: 'configuration',
          label: 'Prompts guardados (~/.codex/prompts)',
          path: join(dir, 'prompts'),
          format: 'markdown',
          editable: false,
          reason: 'Es un directorio; v1 sólo lista lo que hay.',
        },
      ];
    }
    case 'openclaw': {
      const workspace = facts.openclawWorkspace?.trim();
      if (workspace === undefined || !workspace.startsWith('/')) return [];
      const dir = join(facts.home, '.openclaw');
      return [
        {
          kind: 'prompts',
          category: 'profile',
          label: 'Propósito (SOUL.md)',
          path: join(workspace, 'SOUL.md'),
          format: 'markdown',
          editable: false,
          reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
        },
        {
          kind: 'identity',
          category: 'profile',
          label: 'Identidad (IDENTITY.md)',
          path: join(workspace, 'IDENTITY.md'),
          format: 'markdown',
          editable: false,
          reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
        },
        {
          kind: 'human',
          category: 'profile',
          label: 'Contexto humano (USER.md)',
          path: join(workspace, 'USER.md'),
          format: 'markdown',
          editable: false,
          reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
        },
        {
          kind: 'memory',
          category: 'memory',
          label: 'Memoria viva del agente (MEMORY.md)',
          path: join(workspace, 'MEMORY.md'),
          format: 'markdown',
          editable: false,
          reason: 'Pertenece al agente. Cauce acredita su SHA y tamaño, pero no la reescribe.',
        },
        {
          kind: 'heartbeat',
          category: 'memory',
          label: 'Estado vivo del agente (HEARTBEAT.md)',
          path: join(workspace, 'HEARTBEAT.md'),
          format: 'markdown',
          editable: false,
          reason: 'Pertenece al agente. Cauce acredita su SHA y tamaño, pero no lo reescribe.',
        },
        {
          kind: 'directive',
          category: 'manual',
          label: 'Manual del sitio (AGENTS.md)',
          path: join(workspace, 'AGENTS.md'),
          format: 'markdown',
          editable: false,
          reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
        },
        {
          kind: 'tools',
          category: 'configuration',
          label: 'Herramientas declaradas (TOOLS.md)',
          path: join(workspace, 'TOOLS.md'),
          format: 'markdown',
          editable: false,
          reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
        },
        {
          kind: 'configuration',
          category: 'configuration',
          label: 'Configuración sensible (openclaw.json)',
          path: join(dir, 'openclaw.json'),
          format: 'json-fragment',
          editable: false,
          reason: RAZON_OPENCLAW,
        },
      ];
    }
    case 'hermes':
      return [{
        kind: 'directive',
        category: 'manual',
        label: 'AGENTS.md (manual de Hermes)',
        path: join(facts.home, 'AGENTS.md'),
        format: 'markdown',
        editable: true,
      }];
    default:
      return [];
  }
}

/** Documento del juego cerrado que corresponde a un `kind`, o `undefined`. */
export function documentForKind(facts: RuntimeFacts, kind: DocumentKind): AgentDocument | undefined {
  return resolveAgentDocuments(facts).find((doc) => doc.kind === kind);
}

export function harnessFromCommand(cmdline: string): HarnessKind {
  const match = /\bbin\/(claude|codex|openclaw|hermes)\.js\b/.exec(cmdline);
  return match ? (match[1] as HarnessKind) : 'unknown';
}

/**
 * Determina el tipo de arnés a partir de las capacidades reportadas en la presencia del adaptador
 * (`GET /v3/status` -> `presence[].capabilities`).
 */
export function harnessFromCapabilities(capabilities: readonly string[]): HarnessKind {
  for (const capability of capabilities) {
    if (capability === 'harness.claude') return 'claude';
    if (capability === 'harness.codex') return 'codex';
    if (capability === 'harness.openclaw') return 'openclaw';
    if (capability === 'harness.hermes') return 'hermes';
  }
  return 'unknown';
}

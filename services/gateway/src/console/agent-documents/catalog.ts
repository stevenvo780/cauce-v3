import {
  GOVERNANCE_NEVER_SERVE_BASENAMES,
  GOVERNANCE_NEVER_SERVE_SUFFIXES,
  TOPE_CODEX_POR_DEFECTO_BYTES,
  harnessDocumentPaths,
  hasGovernanceSensitivePathSegment,
  parseCodexProjectDocumentConfig,
} from '@cauce/protocol';

/** Running harness inferred from the measured environment. */
export type HarnessKind = 'claude' | 'codex' | 'openclaw' | 'hermes' | 'unknown';

export type DocumentKind =
  | 'directive' | 'tools' | 'prompts' | 'mcp' | 'identity' | 'human'
  | 'memory' | 'heartbeat' | 'configuration';

/** Functional category of the governance document. */
export type DocumentCategory = 'manual' | 'profile' | 'configuration' | 'memory';

export type DocumentFormat = 'markdown' | 'json' | 'toml' | 'json-fragment';

/**
 * Facts of the execution environment observed inside the agent container,
 * needed to resolve canonical governance paths.
 */
export interface RuntimeFacts {
  /** Inferred from the running binary: `bin/claude.js` -> 'claude', etc. */
  readonly harness: HarnessKind;
  /** `HOME` of the harness process. */
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR` if set. */
  readonly claudeConfigDir?: string;
  /** `CODEX_HOME` if set. */
  readonly codexHome?: string;
  /** `cwd` of the process: CLAUDE.md/AGENTS.md at project level come from here. */
  readonly cwd?: string;
  /** Explicit root of the shared workspace; never discovered by walking up to `/`. */
  readonly workspaceRoot?: string;
  /** Project root vouched for by an actual marker inside the workspace (e.g. `.git`). */
  readonly projectRoot?: string;
  /** Non-sensitive projection of config.toml; only valid for Codex. */
  readonly projectDocMaxBytes?: number;
  /** Measured fallback basenames, never paths or the rest of config.toml. */
  readonly projectDocFallbackFilenames?: readonly string[];
  /** Effective OpenClaw workspace; not inferred from HOME or openclaw.json. */
  readonly openclawWorkspace?: string;
  /** Opaque generation of the container that measured these facts. Required to vouch for writes. */
  readonly generation?: string;
  /** Container that published the measurement; evidence, never derived from the SQL registry. */
  readonly containerId?: string;
  /** Terminal capabilities published by that same process. */
  readonly modes?: readonly string[];
}
export interface AgentDocument {
  readonly kind: DocumentKind;
  readonly category: DocumentCategory;
  /** Descriptive label of the document for the console UI. */
  readonly label: string;
  /** Absolute path inside the agent container. */
  readonly path: string;
  readonly format: DocumentFormat;
  /** `true` only if this channel can write it safely. */
  readonly editable: boolean;
  /** Reason why the document cannot be edited. */
  readonly reason?: string;
  /** Warning to show before confirming the write. */
  readonly warning?: string;
}

/**
 * Filenames that are NEVER read or written by this channel, wherever the file lives. Checked by basename and
 * also by already-resolved path (`realpath`), because in `ctrl-infra` `.credentials.json` is a SINGLE-FILE
 * bind-mount placed inside an otherwise own `.claude`: looking only at the directory would not save it.
 */
export const NEVER_SERVE_BASENAMES = GOVERNANCE_NEVER_SERVE_BASENAMES;
export const NEVER_SERVE_SUFFIXES = GOVERNANCE_NEVER_SERVE_SUFFIXES;

export function hasNeverServePathSegment(path: string): boolean {
  return hasGovernanceSensitivePathSegment(path);
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function claudeDir(facts: RuntimeFacts): string {
  const configured = facts.claudeConfigDir?.trim();
  return configured === undefined || configured.length === 0 ? join(facts.home, '.claude') : configured;
}

function codexDir(facts: RuntimeFacts): string {
  const configured = facts.codexHome?.trim();
  return configured === undefined || configured.length === 0 ? join(facts.home, '.codex') : configured;
}

/** Memory root for each harness, derived from overrides measured inside the process. */
export function memoryRootForHarness(facts: RuntimeFacts): string | null {
  const home = facts.home.replace(/\/+$/, '');
  switch (facts.harness) {
    case 'claude':
      return `${claudeDir({ ...facts, home }).replace(/\/+$/, '')}/projects`;
    case 'codex':
      return `${codexDir({ ...facts, home }).replace(/\/+$/, '')}/memories`;
    case 'openclaw': {
      const workspace = facts.openclawWorkspace?.trim().replace(/\/+$/, '');
      return workspace?.startsWith('/') ? `${workspace}/memory` : null;
    }
    default:
      return null;
  }
}

/** Closed set of PROFILE files, read from the single path table of `@cauce/protocol`. */
export function profileDocumentPaths(facts: RuntimeFacts): readonly string[] {
  if (!facts.home.startsWith('/')) return [];
  return harnessDocumentPaths(facts.harness, facts);
}

export interface EffectiveManualPath {
  readonly path: string;
  readonly scope: 'user' | 'workspace';
  /** Lower first. In Claude it describes load order; in Codex later ones take precedence. */
  readonly precedence: number;
  /** Candidates of the same group are tried in order and only the first that exists is loaded. */
  readonly selection: 'all' | 'first_existing';
  readonly group: string;
}

/** Value Codex applies when config.toml does not override it. */
export const DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES = TOPE_CODEX_POR_DEFECTO_BYTES;

export interface CodexProjectDocumentConfig {
  readonly maxBytes: number;
  readonly fallbackFilenames: readonly string[];
}

/**
 * The two knobs form a single vouched projection. An old agent sends neither and a partially updated one
 * could send only one: in both cases the defaults are used, never a mix that Codex did not apply. Validation
 * is repeated in relay and gateway because presence is authenticated but not blindly trusted.
 */
export function measuredCodexProjectDocumentConfig(
  facts: RuntimeFacts,
): CodexProjectDocumentConfig | undefined {
  return parseCodexProjectDocumentConfig({
    harness: facts.harness,
    maxBytes: facts.projectDocMaxBytes,
    fallbackFilenames: facts.projectDocFallbackFilenames,
  });
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
 * Closed and ordered set of manuals the process actually applies.
 *
 * The global layer goes first. With a vouched `projectRoot`, all levels from that root up to cwd are added;
 * without a root only the exact file from cwd is added, which was indeed measured, and the code never walks
 * up looking for `.git` or another plausible marker. OpenClaw keeps exclusively the AGENTS.md of its measured
 * workspace. The same path is returned once, at its first effective position.
 */
export function effectiveManualPaths(facts: RuntimeFacts): readonly EffectiveManualPath[] {
  if (!facts.home.startsWith('/')) return [];
  const candidates: Omit<EffectiveManualPath, 'precedence'>[] = [];
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
      // The audited contract starts from the real project root for both harnesses. The mount may
      // contain several repositories and its CLAUDE.md does not necessarily govern the current
      // process.
    const root = facts.projectRoot;
    if (cwd !== undefined && canonicalContextDirectory(cwd)) {
      let directories: string[] = [];
      if (root === undefined) {
        // Without a vouched root, a single exact level. Hierarchy is not invented.
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
        const group = `workspace:${String(level)}`;
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
 * Claude's `settings.json` may contain `hooks`: orders the harness runs automatically.
 * A warning is emitted to the operator before saving changes to this document.
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

const RAZON_CONTEXTO_CANONICO =
  'Es parte del contexto canónico: se cambia desde Contexto y se aplica como un lote.';

/**
 * Resolves the CLOSED set of documents for an alias. Closed on purpose: the path never comes from the browser;
 * it is derived here from measured facts. The browser sends a `kind`, not a `path`.
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
      if (!workspace?.startsWith('/')) return [];
      const dir = join(facts.home, '.openclaw');
      return [
        {
          kind: 'prompts',
          category: 'profile',
          label: 'Propósito (SOUL.md)',
          path: join(workspace, 'SOUL.md'),
          format: 'markdown',
          editable: false,
          reason: RAZON_CONTEXTO_CANONICO,
        },
        {
          kind: 'identity',
          category: 'profile',
          label: 'Identidad (IDENTITY.md)',
          path: join(workspace, 'IDENTITY.md'),
          format: 'markdown',
          editable: false,
          reason: RAZON_CONTEXTO_CANONICO,
        },
        {
          kind: 'human',
          category: 'profile',
          label: 'Contexto humano (USER.md)',
          path: join(workspace, 'USER.md'),
          format: 'markdown',
          editable: false,
          reason: RAZON_CONTEXTO_CANONICO,
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
          reason: RAZON_CONTEXTO_CANONICO,
        },
        {
          kind: 'tools',
          category: 'configuration',
          label: 'Herramientas declaradas (TOOLS.md)',
          path: join(workspace, 'TOOLS.md'),
          format: 'markdown',
          editable: false,
          reason: RAZON_CONTEXTO_CANONICO,
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

/** Document from the closed set that matches a `kind`, or `undefined`. */
export function documentForKind(facts: RuntimeFacts, kind: DocumentKind): AgentDocument | undefined {
  return resolveAgentDocuments(facts).find((doc) => doc.kind === kind);
}

export function harnessFromCommand(cmdline: string): HarnessKind {
  const match = /\bbin\/(claude|codex|openclaw|hermes)\.js\b/.exec(cmdline);
  return match ? (match[1] as HarnessKind) : 'unknown';
}

/**
 * Determines the harness type from the capabilities reported on the adapter presence
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

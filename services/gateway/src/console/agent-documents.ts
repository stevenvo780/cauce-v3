/**
 * Mapeo y resolución de documentos de gobierno de agentes (directivas, herramientas, prompts, memoria).
 * Resuelve las rutas efectivas a partir de los hechos de entorno en tiempo de ejecución (RuntimeFacts)
 * y previene el acceso o filtrado de archivos con credenciales o configuraciones sensibles.
 */

import { createHash } from 'node:crypto';
import { FICHEROS_OPENCLAW } from '@cauce/protocol';
import type {
  AgentFactsProbe, FactsSource, GovernanceBatchWrite, GovernanceBatchWriteAck,
  GovernanceDocumentContent, GovernanceReadError, GovernanceWritePrecondition, MemoryDirectoryListing
} from './agent-documents.routes.js';

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

const NEVER_SERVE_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx'];

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

function codexFallbackFilenames(facts: RuntimeFacts): readonly string[] {
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

export interface PathVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * ÚNICA puerta que puede consultar el camino de escritura. Falla cerrada.
 *
 * `resolved` es lo que el agente ve tras seguir los enlaces (`realpath`). Se exige porque un
 * `CLAUDE.md` que sea un symlink a `~/.claude/.credentials.json` pasaría cualquier comprobación
 * hecha sólo sobre el nombre pedido.
 */
export function verifyWritablePath(
  facts: RuntimeFacts,
  kind: DocumentKind,
  requested: string,
  resolved: string = requested,
): PathVerdict {
  const doc = documentForKind(facts, kind);
  if (!doc) return { allowed: false, reason: 'ese alias no tiene ese documento' };
  if (!doc.editable) return { allowed: false, reason: doc.reason ?? 'documento de sólo lectura' };
  if (doc.path !== requested) return { allowed: false, reason: 'la ruta no es la del documento resuelto' };

  for (const candidate of [requested, resolved]) {
    if (!candidate.startsWith('/')) return { allowed: false, reason: 'la ruta tiene que ser absoluta' };
    if (candidate.split('/').includes('..')) return { allowed: false, reason: 'la ruta no puede subir de directorio' };
    if (candidate.includes('\0')) return { allowed: false, reason: 'la ruta lleva un byte nulo' };

    const base = candidate.slice(candidate.lastIndexOf('/') + 1);
    if (NEVER_SERVE_BASENAMES.includes(base)) {
      return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
    }
    if (NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      return { allowed: false, reason: `\`${base}\` parece material de credencial` };
    }
  }

  // Tras seguir los enlaces la ruta tiene que seguir siendo la misma. Un `realpath` distinto
  // significa symlink, y un symlink es exactamente el vector que la lista negra no ve.
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta es un enlace; se escribe el fichero, no el enlace' };
  }
  return { allowed: true };
}

/** Puerta separada para el lote de perfil. No habilita settings/openclaw.json ni rutas del UI. */
export function verifyWritableProfilePath(
  facts: RuntimeFacts,
  requested: string,
  resolved: string = requested,
): PathVerdict {
  if (!profileDocumentPaths(facts).includes(requested)) {
    return { allowed: false, reason: 'la ruta no pertenece al juego cerrado del perfil' };
  }
  for (const candidate of [requested, resolved]) {
    if (!candidate.startsWith('/') || candidate.includes('\0') || candidate.length > 4096) {
      return { allowed: false, reason: 'la ruta del perfil no es absoluta o canónica' };
    }
    const segments = candidate.split('/');
    if (segments.includes('..') || segments.includes('.') || segments.slice(1).includes('')) {
      return { allowed: false, reason: 'la ruta del perfil no está en forma canónica' };
    }
    const base = segments[segments.length - 1] ?? '';
    if (NEVER_SERVE_BASENAMES.includes(base)
      || NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      return { allowed: false, reason: 'el destino parece material sensible' };
    }
  }
  if (resolved !== requested) {
    return { allowed: false, reason: 'la ruta del perfil es un enlace' };
  }
  return { allowed: true };
}

/**
 * Límite máximo de tamaño permitido para lectura y escritura de documentos de gobierno (256 KB).
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

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

/**
 * Nombres que esta vía SÍ sirve. Es una lista blanca, no una negra: el modal de Directiva enseña
 * el manual del sitio y nada más. `settings.json` y `config.toml` salen en el inventario de
 * `resolveAgentDocuments` porque hay que poder verlos y editarlos, pero por el canal de LECTURA
 * del pty-agent no viajan — y el propio pty-agent los rechaza aunque el gateway los pida.
 */
export const READ_ALLOWED_BASENAMES: readonly string[] = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md',
];
const PROFILE_READ_BASENAMES: readonly string[] = [...FICHEROS_OPENCLAW, ...READ_ALLOWED_BASENAMES];

/**
 * ÚNICA puerta del camino de LECTURA, hermana de `verifyWritablePath`. Falla cerrada.
 *
 * Repite a propósito comprobaciones que el pty-agent vuelve a hacer por su cuenta
 * (`_validate_read_path`). No es duplicación por descuido: son dos defensas independientes, y un
 * fallo en una sola no debe bastar para servir una credencial. Lo que el gateway NO puede hacer
 * desde aquí es seguir enlaces —el fichero vive en otra máquina, dentro de otro contenedor—, así
 * que el `realpath` lo comprueba el agente y sólo el agente.
 */
export function verifyReadablePath(facts: RuntimeFacts, requested: string): PathVerdict {
  if (!requested.startsWith('/')) return { allowed: false, reason: 'la ruta tiene que ser absoluta' };
  if (requested.includes('\0')) return { allowed: false, reason: 'la ruta lleva un byte nulo' };
  if (requested.length > 4096) return { allowed: false, reason: 'la ruta es demasiado larga' };

  // Se exige forma canónica en vez de normalizar. Normalizar es justo donde aparecen las
  // diferencias entre lo que valida el gateway y lo que abre el agente.
  const segments = requested.split('/');
  if (segments.includes('..') || segments.includes('.') || segments.slice(1).includes('')) {
    return { allowed: false, reason: 'la ruta no está en forma canónica' };
  }

  const base = segments[segments.length - 1] ?? '';
  if (NEVER_SERVE_BASENAMES.includes(base)) {
    return { allowed: false, reason: `\`${base}\` no se sirve nunca por esta vía` };
  }
  if (NEVER_SERVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return { allowed: false, reason: `\`${base}\` parece material de credencial` };
  }
  const profilePath = profileDocumentPaths(facts).includes(requested);
  const effectiveManual = effectiveManualPaths(facts).some((manual) => manual.path === requested);
  const configuredCodexFallback = facts.harness === 'codex'
    && codexFallbackFilenames(facts).includes(base) && effectiveManual;
  if (!READ_ALLOWED_BASENAMES.includes(base)
      && !(profilePath && PROFILE_READ_BASENAMES.includes(base)) && !configuredCodexFallback) {
    return {
      allowed: false,
      reason: `\`${base}\` no es un manual efectivo permitido para ese arnés`,
    };
  }

  // El juego CERRADO manda: la ruta tiene que ser una de las que se derivan de hechos medidos.
  // El navegador manda un alias, nunca una ruta, y esto lo vuelve a exigir aquí abajo.
  if (!resolveAgentDocuments(facts).some((doc) => doc.path === requested)
      && !profilePath && !effectiveManual) {
    return { allowed: false, reason: 'la ruta no es la de ningún documento de ese alias' };
  }
  return { allowed: true };
}

/**
 * Decide si una fila del inventario tiene contenido servible por la ruta `:kind/content`.
 *
 * `editable` no sirve para tomar esta decisión: los manuales de proyecto y los ficheros que
 * componen el perfil OpenClaw se pueden inspeccionar, pero sus escrituras pasan por otras reglas
 * (o por el lote canónico de Perfil). A la inversa, que una fila exista en el inventario tampoco
 * la vuelve legible: `settings.json`, `config.toml`, directorios y configuraciones con secretos se
 * enumeran para explicar dónde viven, pero nunca se abren desde el navegador.
 *
 * La categoría sólo acota la intención. La autoridad final sigue siendo `verifyReadablePath`,
 * que exige una ruta absoluta y canónica dentro del juego cerrado derivado de hechos medidos.
 */
export function verifyReadableDocument(facts: RuntimeFacts, document: AgentDocument): PathVerdict {
  const profilePath = profileDocumentPaths(facts).includes(document.path);
  if (document.category !== 'manual' && !profilePath) {
    return {
      allowed: false,
      reason: document.reason ?? 'este elemento se inventaría, pero su contenido no se sirve por esta vía',
    };
  }
  return verifyReadablePath(facts, document.path);
}

/** Lo que el pty-agent devuelve tras leer, ya acumulado por el terminal-relay. */
export interface RelayFileRead {
  readonly path: string;
  /** Tamaño REAL del fichero, aunque `content` venga recortado. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly modified_at: string;
  readonly sha: string;
  readonly content: string;
}

/** Forma interna del índice del relay: todavía usa rutas absolutas acreditadas por el agente. */
export interface RelayDirectoryRead {
  readonly path: string;
  readonly total: number | null;
  readonly observed_at_least: number;
  readonly truncated: boolean;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly modified_at: string;
  }>;
}

export interface RelayFileWrite {
  readonly path: string;
  readonly operation: 'replace' | 'create';
  readonly sha: string;
  readonly bytes: number;
}

export interface RelayFileWriteBatch {
  readonly files: readonly GovernanceBatchWriteAck[];
}

export type GovernanceWriteError = GovernanceReadError | { readonly error: 'conflict'; readonly reason: string };

/**
 * Lo poco que el gateway necesita del terminal-relay. Se declara aquí, y no se importa del
 * paquete del relay, porque son dos procesos en dos máquinas: lo que los une es este contrato.
 */
export interface GovernanceRelayClient {
  readFile(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayFileRead | GovernanceReadError>;
  /** Ausente sólo en implementaciones legacy; nunca se sustituye por un índice vacío. */
  listDirectory?(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayDirectoryRead | GovernanceReadError>;
  /** Ausente en dobles/clientes antiguos; la sonda falla honesta y no afirma aplicación. */
  writeFile?(
    tenantId: string,
    alias: string,
    path: string,
    content: string,
    precondition: GovernanceWritePrecondition,
  ): Promise<RelayFileWrite | GovernanceWriteError>;
  writeFiles?(
    tenantId: string,
    alias: string,
    writes: readonly GovernanceBatchWrite[],
  ): Promise<RelayFileWriteBatch | GovernanceWriteError>;
}

/** De dónde salen los hechos medidos. Se inyecta para no atar el probe al almacén. */
export interface MeasuredFactsSource {
  factsFor(tenantId: string, alias: string): Promise<{ facts: RuntimeFacts; source: FactsSource } | undefined>;
}

/**
 * `AgentFactsProbe` que lee de verdad, pasando por el terminal-relay y el pty-agent.
 *
 * Hasta hoy la interfaz sólo la implementaban los dobles de los tests, así que el modal de
 * Directiva no tenía de dónde sacar el texto. Esto es esa pieza.
 */
export class TerminalRelayFactsProbe implements AgentFactsProbe {
  private readonly facts: MeasuredFactsSource;
  private readonly relay: GovernanceRelayClient;

  constructor(facts: MeasuredFactsSource, relay: GovernanceRelayClient) {
    this.facts = facts;
    this.relay = relay;
  }

  async factsFor(tenantId: string, alias: string): Promise<{ facts: RuntimeFacts; source: FactsSource } | undefined> {
    return this.facts.factsFor(tenantId, alias);
  }

  async readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<GovernanceDocumentContent | GovernanceReadError> {
    const verdict = verifyReadablePath(facts, path);
    if (!verdict.allowed) {
      return { error: 'invalid_path', reason: verdict.reason ?? 'ruta no permitida' };
    }

    let answer: RelayFileRead | GovernanceReadError;
    try {
      answer = await this.relay.readFile(tenantId, alias, path, signal);
    } catch (error) {
      // Que el relay reviente no puede tumbar la pantalla entera: se cuenta como lectura fallida.
      return { error: 'unknown', reason: `la lectura falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    if (answer.path !== path) {
      return { error: 'unknown', reason: 'la respuesta es de otra ruta distinta de la pedida' };
    }
    if (!Number.isInteger(answer.bytes) || answer.bytes < 0) {
      return { error: 'unknown', reason: 'la respuesta no trae un tamaño creíble' };
    }
    if (!/^[0-9a-f]{64}$/.test(answer.sha)) {
      return { error: 'unknown', reason: 'la respuesta no trae una huella SHA-256 válida' };
    }

    // OJO con las unidades: `MAX_DOCUMENT_BYTES` son BYTES y `string.length` son unidades UTF-16.
    // Compararlos directamente deja pasar de largo cualquier documento con acentos, que aquí los
    // hay en todos. Se mide con `byteLength` y se recorta sobre el buffer.
    const size = Buffer.byteLength(answer.content, 'utf8');
    if (!answer.truncated && size !== answer.bytes) {
      return { error: 'unknown', reason: 'el tamaño de la lectura no coincide con su contenido' };
    }
    if (!answer.truncated && createHash('sha256').update(answer.content, 'utf8').digest('hex') !== answer.sha) {
      return { error: 'unknown', reason: 'la huella de la lectura no coincide con su contenido' };
    }
    const overflowed = size > MAX_DOCUMENT_BYTES;
    const text = overflowed
      ? Buffer.from(answer.content, 'utf8').subarray(0, MAX_DOCUMENT_BYTES).toString('utf8')
      : answer.content;

    return {
      text,
      bytes: answer.bytes,
      truncated: answer.truncated || overflowed,
      modified_at: answer.modified_at,
      sha: answer.sha,
    };
  }

  async writeGovernanceDocument(
    path: string,
    contenido: string,
    precondition: GovernanceWritePrecondition,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<{ sha: string; bytes: number } | GovernanceWriteError> {
    const kind = documentForPathKind(facts, path);
    if (kind === undefined) {
      return { error: 'invalid_path', reason: 'la ruta no pertenece al juego cerrado de documentos' };
    }
    const verdict = verifyWritablePath(facts, kind, path);
    if (!verdict.allowed) {
      return { error: 'invalid_path', reason: verdict.reason ?? 'ruta no permitida' };
    }
    const raw = Buffer.from(contenido, 'utf8');
    if (raw.byteLength > MAX_DOCUMENT_BYTES) {
      return { error: 'too_large', reason: 'el contenido se pasa del tope de 256 KiB' };
    }
    if (precondition.state === 'present' && !/^[0-9a-f]{64}$/.test(precondition.sha256)) {
      return { error: 'invalid_path', reason: 'la precondición de reemplazo no es un SHA-256 válido' };
    }
    if (this.relay.writeFile === undefined) {
      return { error: 'unavailable', reason: 'el cliente del terminal-relay no publica escritura gobernada' };
    }

    let answer: RelayFileWrite | GovernanceWriteError;
    try {
      answer = await this.relay.writeFile(tenantId, alias, path, contenido, precondition);
    } catch (error) {
      return { error: 'unknown', reason: `la escritura falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    const expectedOperation = precondition.state === 'present' ? 'replace' : 'create';
    const expectedSha = createHash('sha256').update(raw).digest('hex');
    if (answer.path !== path || answer.operation !== expectedOperation
      || answer.sha !== expectedSha || answer.bytes !== raw.byteLength) {
      return { error: 'unknown', reason: 'el ACK del relay no acredita el contenido solicitado' };
    }
    return { sha: answer.sha, bytes: answer.bytes };
  }

  async writeGovernanceBatch(
    writes: readonly GovernanceBatchWrite[],
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<readonly GovernanceBatchWriteAck[] | GovernanceWriteError> {
    if (writes.length === 0 || writes.length > 7 || this.relay.writeFiles === undefined) {
      return { error: 'unavailable', reason: 'el relay no publica el lote gobernado del perfil' };
    }
    const seen = new Set<string>();
    for (const write of writes) {
      const verdict = verifyWritableProfilePath(facts, write.path);
      if (!verdict.allowed || seen.has(write.path)) {
        return { error: 'invalid_path', reason: verdict.reason ?? 'el lote repite una ruta' };
      }
      seen.add(write.path);
      if (write.mode === 'write' && Buffer.byteLength(write.content, 'utf8') > MAX_DOCUMENT_BYTES) {
        return { error: 'too_large', reason: 'un documento del perfil se pasa de 256 KiB' };
      }
      if (write.precondition.state === 'present' && !/^[0-9a-f]{64}$/.test(write.precondition.sha256)) {
        return { error: 'invalid_path', reason: 'una precondición del lote no es un SHA-256 válido' };
      }
    }

    let answer: RelayFileWriteBatch | GovernanceWriteError;
    try {
      answer = await this.relay.writeFiles(tenantId, alias, writes);
    } catch (error) {
      return { error: 'unknown', reason: `el lote falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    if (answer.files.length !== writes.length) {
      return { error: 'unknown', reason: 'el ACK del lote no acredita todos los documentos' };
    }
    const byPath = new Map(answer.files.map((file) => [file.path, file]));
    if (byPath.size !== writes.length) {
      return { error: 'unknown', reason: 'el ACK del lote repite documentos' };
    }
    const acknowledgements: GovernanceBatchWriteAck[] = [];
    for (const write of writes) {
      const file = byPath.get(write.path);
      if (file === undefined) {
        return { error: 'unknown', reason: 'un ACK del lote no coincide con el contenido solicitado' };
      }
      if (write.mode === 'verify') {
        const valid = write.precondition.state === 'present'
          ? file.operation === 'unchanged' && file.sha === write.precondition.sha256
          : file.operation === 'absent' && file.sha === null && file.bytes === 0;
        if (!valid) {
          return { error: 'unknown', reason: 'un ACK del lote no acredita el fichero preservado' };
        }
      } else {
        const content = Buffer.from(write.content, 'utf8');
        const expectedOperation = write.precondition.state === 'present' ? 'replace' : 'create';
        const expectedSha = createHash('sha256').update(content).digest('hex');
        if ((file.operation !== expectedOperation && file.operation !== 'unchanged')
          || file.sha !== expectedSha || file.bytes !== content.byteLength) {
          return { error: 'unknown', reason: 'un ACK del lote no coincide con el contenido solicitado' };
        }
      }
      acknowledgements.push(file);
    }
    return acknowledgements;
  }

  async listMemoryDirectory(
    memoryRoot: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<MemoryDirectoryListing | GovernanceReadError> {
    const expectedRoot = memoryRootForHarness(facts);
    if (expectedRoot === null || memoryRoot !== expectedRoot || !canonicalAbsoluteMemoryPath(memoryRoot)) {
      return { error: 'invalid_path', reason: 'la raíz pedida no es la memoria medida de ese arnés' };
    }
    if (this.relay.listDirectory === undefined) {
      return { error: 'unavailable', reason: 'el cliente del terminal-relay no publica índices de memoria' };
    }

    let answer: RelayDirectoryRead | GovernanceReadError;
    try {
      answer = await this.relay.listDirectory(tenantId, alias, memoryRoot, signal);
    } catch (error) {
      return { error: 'unknown', reason: `el índice falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;

    const response = answer as unknown as Record<string, unknown>;
    const topKeys = Object.keys(response).sort();
    if (topKeys.length !== 5 || topKeys.some((key, index) => key !== [
      'entries', 'observed_at_least', 'path', 'total', 'truncated',
    ][index])) {
      return { error: 'unknown', reason: 'el relay devolvió un índice con campos desconocidos' };
    }
    const total = response.total;
    const observedAtLeast = response.observed_at_least;
    const truncated = response.truncated;
    const rawEntries = response.entries;
    if (response.path !== memoryRoot
        || (total !== null && (!Number.isSafeInteger(total) || (total as number) < 0))
        || !Number.isSafeInteger(observedAtLeast) || (observedAtLeast as number) < 0
        || typeof truncated !== 'boolean' || !Array.isArray(rawEntries)
        || rawEntries.length > MAX_MEMORY_DIRECTORY_ENTRIES
        || (observedAtLeast as number) < rawEntries.length
        || (total !== null && total !== observedAtLeast)
        || (total === null && !truncated)
        || (!truncated && (total !== rawEntries.length || observedAtLeast !== rawEntries.length))) {
      return { error: 'unknown', reason: 'el relay devolvió un índice con raíz, límites o conteos inválidos' };
    }

    const entries: MemoryDirectoryListing['entries'] = [];
    const seen = new Set<string>();
    for (const rawEntry of rawEntries as unknown[]) {
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada de memoria inválida' };
      }
      const record = rawEntry as Record<string, unknown>;
      if (record.symlink === true || record.type === 'symlink') {
        return { error: 'symlink_detected', reason: 'el índice intentó publicar un enlace simbólico' };
      }
      const keys = Object.keys(record).sort();
      if (keys.length !== 3 || keys.some((key, index) => key !== ['bytes', 'modified_at', 'path'][index])) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada con campos desconocidos' };
      }
      const entryPath = record.path;
      const bytes = record.bytes;
      const modifiedAt = record.modified_at;
      if (!canonicalAbsoluteMemoryPath(entryPath)
          || !entryPath.startsWith(`${memoryRoot}/`)
          || seen.has(entryPath)
          || !Number.isSafeInteger(bytes) || (bytes as number) < 0
          || !validMemoryTimestamp(modifiedAt)) {
        return { error: 'unknown', reason: 'el relay devolvió una ruta, fecha o tamaño de memoria inválidos' };
      }
      const relative = entryPath.slice(memoryRoot.length + 1);
      if (!canonicalRelativeMemoryPath(relative)) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada fuera de la raíz de memoria' };
      }
      if (sensitiveMemoryPath(relative)) {
        return { error: 'permission_denied', reason: 'el índice intentó publicar metadata de credenciales' };
      }
      seen.add(entryPath);
      entries.push({ path: relative, bytes: bytes as number, modified_at: modifiedAt });
    }

    return {
      root: memoryRoot,
      total: total as number | null,
      observed_at_least: observedAtLeast as number,
      truncated,
      entries,
    };
  }
}

const MAX_MEMORY_DIRECTORY_ENTRIES = 200;
const MAX_MEMORY_PATH_BYTES = 4_096;
const MAX_MEMORY_DATE_BYTES = 64;

function canonicalAbsoluteMemoryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PATH_BYTES
      || hasMemoryControlCharacter(value)) return false;
  const segments = value.split('/');
  return !segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function canonicalRelativeMemoryPath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PATH_BYTES
      || hasMemoryControlCharacter(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function hasMemoryControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function sensitiveMemoryPath(relative: string): boolean {
  return relative.split('/').some((segment) => NEVER_SERVE_BASENAMES.includes(segment)
    || NEVER_SERVE_SUFFIXES.some((suffix) => segment.endsWith(suffix)));
}

function validMemoryTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_DATE_BYTES) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const date = new Date(value);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

/** `verifyWritablePath` exige kind: lo deriva sólo del mismo juego cerrado que produjo la ruta. */
function documentForPathKind(facts: RuntimeFacts, path: string): DocumentKind | undefined {
  return resolveAgentDocuments(facts).find((document) => document.path === path)?.kind;
}

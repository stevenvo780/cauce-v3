/**
 * Qué fichero es "la directiva", "las herramientas" y "los prompts" de un alias — y cuáles no se
 * tocan nunca.
 *
 * Todo lo de aquí sale de una medición del 23-ago-2026 sobre los 14 alias vivos, hecha dentro de
 * sus contenedores (`docs/directiva-ficheros-del-agente.md` tiene la tabla y cómo se midió). Tres
 * hechos de esa medición gobiernan el diseño y conviene no perderlos de vista:
 *
 * 1. **`agents.harness_id` de la base MIENTE en 5 de 14 alias.** Medido por el binario que de
 *    verdad corre (`/proc/<pid>/cmdline`): kant, kratos, heraclito y salva ejecutan `claude.js`
 *    con `codex`/`openclaw` escrito en la base, y argos ejecuta `openclaw.js` con `hermes` escrito.
 *    Un editor que resuelva la ruta desde la columna le enseñaría a Steven un fichero que ese
 *    agente NO lee, y al guardar escribiría en el sitio equivocado sin dar un solo error. Por eso
 *    `resolveAgentDocuments` NO acepta el harness de la base: exige `RuntimeFacts`, que sólo puede
 *    producir algo que corra DENTRO del contenedor (hoy, el pty-agent).
 *
 * 2. **El home no basta.** atlas corre con `CODEX_HOME=/home/dev/.codex/cuenta-b`, así que su
 *    directiva es `/home/dev/.codex/cuenta-b/AGENTS.md` y no `~/.codex/AGENTS.md` — que también
 *    existe, con el mismo tamaño, y es el que un resolutor ingenuo abriría.
 *
 * 3. **Los ficheros de configuración mezclan la directiva con credenciales.** `openclaw.json`
 *    lleva `auth` y `secrets` en el MISMO documento que `tools`, `skills`, `mcp` y `commands`;
 *    `~/.claude.json` lleva `mcpServers` junto al OAuth y a 34 historiales de proyecto. Servir
 *    esos ficheros enteros a un navegador es una fuga, no una funcionalidad. Están en la lista
 *    negra y se proyectan campo a campo o no se sirven.
 */

/** Arnés REAL, deducido del binario que corre. Nunca de `agents.harness_id`. */
export type HarnessKind = 'claude' | 'codex' | 'openclaw' | 'unknown';

export type DocumentKind = 'directive' | 'tools' | 'prompts' | 'mcp';

export type DocumentFormat = 'markdown' | 'json' | 'toml' | 'json-fragment';

/**
 * Lo que hay que MEDIR dentro del contenedor para poder resolver una ruta. Nada de esto se puede
 * inferir desde la base ni desde el host: para `kant`, que es host-native y corre como `stev`,
 * ni siquiera se puede leer `/proc/<pid>/environ` desde otra cuenta.
 */
export interface RuntimeFacts {
  /** Deducido del binario en ejecución: `bin/claude.js` -> 'claude', etc. */
  readonly harness: HarnessKind;
  /** `HOME` del proceso del arnés. */
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR` si está puesto. Mueve TAMBIÉN el `.claude.json`, no sólo el CLAUDE.md. */
  readonly claudeConfigDir?: string;
  /** `CODEX_HOME` si está puesto. */
  readonly codexHome?: string;
  /** `cwd` del proceso: de ahí salen los CLAUDE.md/AGENTS.md de nivel proyecto. */
  readonly cwd?: string;
}

export interface AgentDocument {
  readonly kind: DocumentKind;
  /** Rótulo en castellano, el que ve Steven. */
  readonly label: string;
  /** Ruta absoluta DENTRO del contenedor del agente. */
  readonly path: string;
  readonly format: DocumentFormat;
  /** `true` sólo si esta vía puede escribirlo con seguridad. */
  readonly editable: boolean;
  /** Por qué no se puede editar. Se enseña tal cual; un campo muerto sin explicación es peor. */
  readonly reason?: string;
  /** Advertencia que hay que enseñar ANTES de dejar guardar. */
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

/**
 * `settings.json` de Claude lleva `hooks`, y un hook es una orden de shell que el arnés ejecuta
 * solo. Editarlo desde una web es ejecución remota dentro del contenedor, aunque no lo parezca.
 * No lo prohibimos —es justo lo que Steven pidió poder ver y tocar— pero el aviso viaja con el
 * documento para que la pantalla lo enseñe antes de guardar, no después.
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
          label: 'CLAUDE.md (manual del sitio)',
          path: join(dir, 'CLAUDE.md'),
          format: 'markdown',
          editable: true,
        },
        {
          kind: 'tools',
          label: 'Herramientas y permisos (settings.json)',
          path: join(dir, 'settings.json'),
          format: 'json',
          editable: true,
          warning: AVISO_HOOKS,
        },
        {
          kind: 'prompts',
          label: 'Subagentes (~/.claude/agents)',
          path: join(dir, 'agents'),
          format: 'markdown',
          editable: false,
          reason: 'Es un directorio; v1 sólo lista lo que hay, no edita fichero a fichero.',
        },
        {
          kind: 'mcp',
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
          label: 'AGENTS.md (manual del sitio)',
          path: join(dir, 'AGENTS.md'),
          format: 'markdown',
          editable: true,
        },
        {
          kind: 'tools',
          label: 'Herramientas y MCP (config.toml)',
          path: join(dir, 'config.toml'),
          format: 'toml',
          editable: false,
          reason: RAZON_CONFIG_TOML,
        },
        {
          kind: 'prompts',
          label: 'Prompts guardados (~/.codex/prompts)',
          path: join(dir, 'prompts'),
          format: 'markdown',
          editable: false,
          reason: 'Es un directorio; v1 sólo lista lo que hay.',
        },
      ];
    }
    case 'openclaw': {
      const dir = join(facts.home, '.openclaw');
      return [
        {
          kind: 'directive',
          label: 'Directiva del agente (openclaw.json → agents)',
          path: join(dir, 'openclaw.json'),
          format: 'json-fragment',
          editable: false,
          reason: RAZON_OPENCLAW,
        },
        {
          kind: 'tools',
          label: 'Herramientas y skills (openclaw.json → tools/skills)',
          path: join(dir, 'openclaw.json'),
          format: 'json-fragment',
          editable: false,
          reason: RAZON_OPENCLAW,
        },
      ];
    }
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

/**
 * Tope de tamaño. El `CLAUDE.md` más grande medido en la flota es el de zeus (10.733 B) y el
 * `AGENTS.md` de hermes en ctrl-infra llega a 75 KB, así que 256 KB deja margen de sobra sin
 * convertir el editor en una vía para volcar un fichero dentro de un contenedor.
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export function harnessFromCommand(cmdline: string): HarnessKind {
  const match = /\bbin\/(claude|codex|openclaw)\.js\b/.exec(cmdline);
  return match ? (match[1] as HarnessKind) : 'unknown';
}

/**
 * El arnés a partir de las capacidades que el adaptador ya publica en su latido
 * (`GET /v3/status` -> `presence[].capabilities` -> `harness.claude` | `harness.codex` |
 * `harness.openclaw`).
 *
 * Esto NO es un tercer sitio donde adivinar: el 23-ago-2026 se comparó alias por alias contra el
 * binario en ejecución dentro de cada contenedor y coincidió en **14 de 14**, mientras
 * `agents.harness_id` fallaba en 5. O sea: la respuesta correcta YA viaja por el cable y ya está
 * desplegada; lo que falta es que alguien la use en vez de la columna. La página «La flota ahora»
 * enseña la columna, y por eso pinta «iza (hermes @ ws-humanizar)» cuando iza corre `openclaw.js`
 * en `claw-iza`.
 *
 * Sigue sin ser una medición completa: da el arnés, no el `HOME` ni el `CODEX_HOME`, y el arnés
 * sale del bundle del adaptador, no de leerle el `cmdline` al proceso. Por eso su fuente es
 * `presence` y no `measured`, y por eso no basta para marcar nada editable.
 */
export function harnessFromCapabilities(capabilities: readonly string[]): HarnessKind {
  for (const capability of capabilities) {
    if (capability === 'harness.claude') return 'claude';
    if (capability === 'harness.codex') return 'codex';
    if (capability === 'harness.openclaw') return 'openclaw';
  }
  return 'unknown';
}

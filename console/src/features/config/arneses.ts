/** How each harness interacts with its configuration files and declared role. */

interface ArnesReal {
  /** Same identifier as `HarnessKind` in the gateway document catalog. */
  id: string;
  label: string;
  /** Exact location from which the harness reads its effective manual. */
  directiva: string;
  /** Why this path is authoritative, so nobody "fixes" it from registry guesses. */
  detalle: string;
  /**
   * Always false: no harness document is changed from Settings. Editable manuals live in the
   * agent drawer and still require measured runtime facts.
   */
  editableDesdeAjustes: false;
  /** Where it can actually be changed; a prohibition without a destination is not actionable. */
  dondeSeToca: string;
}

/** The closed harness set currently recognized by the gateway document inventory. */
export const ARNESES_REALES: readonly ArnesReal[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    directiva: '<HOME>/.claude/CLAUDE.md',
    detalle: 'Si el proceso lleva `CLAUDE_CONFIG_DIR`, el fichero se mueve con él — y ese ajuste '
      + 'arrastra también el `.claude.json` de los MCP, no sólo el manual.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En la pestaña única «Contexto» del bot: los campos canónicos y el editor manual '
      + 'están juntos, y sólo escriben con hechos del runtime medidos.',
  },
  {
    id: 'codex',
    label: 'Codex',
    directiva: '<HOME>/.codex/AGENTS.md',
    detalle: 'Si el proceso lleva `CODEX_HOME`, la directiva es la de ESA carpeta. Hay alias con las '
      + 'dos, del mismo tamaño, y la de `~/.codex` es la que abriría un resolutor ingenuo.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En la pestaña única «Contexto» del bot, con el entorno del proceso medido. Su '
      + '`config.toml` sigue de sólo lectura: un TOML mal formado deja al bot sin arrancar.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    directiva: '<WORKSPACE_OPENCLAW>/AGENTS.md',
    detalle: 'El perfil canónico se proyecta en ficheros Markdown separados del workspace. '
      + '`openclaw.json` conserva auth, secrets y configuración sensible y no se sirve en el navegador.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Contexto» se editan los campos canónicos que Cauce proyecta. La configuración '
      + 'sensible de `openclaw.json` no se edita desde la consola.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    directiva: '<HOME>/AGENTS.md',
    detalle: 'El inventario puede resolver ese manual con hechos medidos, pero el perfil canónico '
      + 'por lote no declara soporte para Hermes. Son capacidades distintas.',
    editableDesdeAjustes: false,
    dondeSeToca: '«Contexto» concentra el manual cuando el runtime acredita su ruta. No promete '
      + 'aplicar el perfil canónico por lote a Hermes.',
  },
];

/** Explains the canonical source of the declared role and the read-only registry projection. */
export const DONDE_SE_ESCRIBE_EL_ROL_DECLARADO =
  '`agents.role_brief` es una proyección diagnóstica de sólo lectura y el editor genérico rechaza '
  + 'mutarla. El rol declarado se redacta una sola vez en la pestaña «Contexto» del bot, sobre '
  + '`agent_profiles.role_summary`. El servidor lo lee con `selfRoleFromProfile` y lo publica como '
  + '`self_role`; la aplicación a ficheros depende del soporte acreditado de cada arnés.';

/** Declared tools are authored guidance; they are never an authorization or runtime capability grant. */
export const DISTINCION_HERRAMIENTAS_Y_PERMISOS =
  'Las herramientas declaradas en «Contexto» son instrucciones para el agente: no habilitan '
  + 'binarios, MCP ni permisos. Las capacidades acreditadas salen del runtime; la autorización '
  + 'sale de membresías, role_policies, ACL y RBAC. Son planos distintos.';

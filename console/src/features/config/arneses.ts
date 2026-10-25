/** How each harness interacts with its configuration files and declared role. */

interface ArnesReal {
  /** Same identifier as `HarnessKind` in the gateway document catalog. */
  id: string;
  label: string;
  /** One sentence for the person choosing: which program this card is, before any path. */
  aporta: string;
  /** Exact location from which the harness reads its effective manual. */
  directiva: string;
  /** Why this path is authoritative, so nobody "fixes" it from registry guesses. */
  detalle: string;
  /**
   * Always false: no harness document is changed from Settings. Editable manuals live in the
   * agent context page and still require measured runtime facts.
   */
  editableDesdeAjustes: false;
  /** Where it can actually be changed; a prohibition without a destination is not actionable. */
  dondeSeToca: string;
}

const HARNESSES_WITHOUT_A_MEASURED_CARD = new Set(['fake', 'fake2', 'opencode']);

/** The closed harness set currently recognized by the gateway document inventory. */
export const ARNESES_REALES: readonly ArnesReal[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    aporta: 'El agente ya corre Claude Code. Esta tarjeta no lo cambia: dice qué manual lee.',
    directiva: '<HOME>/.claude/CLAUDE.md',
    detalle: 'Si el agente usa otra carpeta de configuración, el manual se lee desde esa carpeta '
      + 'y no desde la personal.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Perfil y contexto» del agente: los campos canónicos y el editor manual '
      + 'están juntos, y solo escriben con datos comprobados de la ejecución.',
  },
  {
    id: 'codex',
    label: 'Codex',
    aporta: 'El agente ya corre Codex. Esta tarjeta no lo cambia: dice qué manual lee.',
    directiva: '<HOME>/.codex/AGENTS.md',
    detalle: 'Si el agente se ejecuta con una carpeta de configuración propia, el manual es el de ESA carpeta, '
      + 'no el de la carpeta personal. Hay agentes con las dos y se parecen mucho: no los confundas.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Perfil y contexto» del agente, con el entorno del proceso medido. Su '
      + 'archivo de configuración sigue de solo lectura: si se escribiera mal, el agente no podría arrancar.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    aporta: 'El agente ya corre OpenClaw. El manual está en su espacio de trabajo, no en la carpeta personal.',
    directiva: '<WORKSPACE_OPENCLAW>/AGENTS.md',
    detalle: 'El perfil canónico se proyecta en ficheros Markdown separados del espacio de trabajo. '
      + 'El archivo de configuración de OpenClaw guarda credenciales y ajustes sensibles, y no se muestra en el navegador.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Perfil y contexto» se editan los campos canónicos que Cauce proyecta. La configuración '
      + 'sensible del archivo de configuración de OpenClaw no se edita desde la consola.',
  },
  {
    id: 'grok',
    label: 'Grok',
    aporta: 'El agente ya corre Grok. El manual solo cuenta si la ejecución comprobó su espacio de trabajo.',
    directiva: '<WORKSPACE_GROK>/AGENTS.md',
    detalle: 'Solo se da por bueno el manual cuando la ejecución comprueba el espacio de trabajo. '
      + 'La carpeta de acceso de Grok no demuestra cuál es el proyecto del agente.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Perfil y contexto» del agente, sobre el espacio de trabajo comprobado. El manual forma '
      + 'parte del contexto canónico y se aplica en un solo paso.',
  },
  {
    id: 'muse',
    label: 'Muse',
    aporta: 'El agente ya corre Muse. El manual solo cuenta si la ejecución comprobó su espacio de trabajo.',
    directiva: '<WORKSPACE_MUSE>/AGENTS.md',
    detalle: 'Solo se da por bueno el manual cuando la ejecución comprueba el espacio de trabajo. '
      + 'Un Muse en modo puente, sin espacio de trabajo, no demuestra la ruta de su manual.',
    editableDesdeAjustes: false,
    dondeSeToca: 'En «Perfil y contexto» del agente, sobre el espacio de trabajo comprobado. El manual forma '
      + 'parte del contexto canónico y se aplica en un solo paso.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    aporta: 'El agente ya corre Hermes. Puede leer un manual; el perfil por lote no se le aplica.',
    directiva: '<HOME>/AGENTS.md',
    detalle: 'Se puede localizar ese manual con datos comprobados, pero el perfil canónico '
      + 'no se aplica en bloque a Hermes. Son cosas distintas.',
    editableDesdeAjustes: false,
    dondeSeToca: '«Perfil y contexto» reúne el manual cuando la ejecución demuestra su ruta. No promete '
      + 'aplicar a Hermes el perfil canónico en bloque.',
  },
];

export function arnesesEnLaConsola(
  descriptors: readonly { readonly harness: string; readonly context?: { readonly native_document?: string } }[],
): readonly ArnesReal[] {
  const known = new Set(ARNESES_REALES.map((item) => item.id));
  const extras: ArnesReal[] = [];
  for (const descriptor of descriptors) {
    if (known.has(descriptor.harness) || HARNESSES_WITHOUT_A_MEASURED_CARD.has(descriptor.harness)) continue;
    const document = descriptor.context?.native_document;
    extras.push({
      id: descriptor.harness,
      label: descriptor.harness,
      aporta: 'Programa que esta consola todavía no ficha. La tarjeta muestra el manual declarado, sin inventar una ruta.',
      directiva: document === undefined || document === 'none' || document === '' ? '' : document,
      detalle: 'La definición declara este manual. La carpeta exacta se comprueba durante la ejecución; esta ficha no inventa una ruta.',
      editableDesdeAjustes: false,
      dondeSeToca: 'En «Perfil y contexto» del agente, cuando la ejecución acredita la ruta.',
    });
  }
  extras.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return [...ARNESES_REALES, ...extras];
}

/** The choice this screen does not offer: the running program is already the harness. */
export const DECISION_DEL_ARNES =
  'No eliges el programa aquí. Es el que ya está corriendo el agente. Cada tarjeta dice qué archivo '
  + 'de instrucciones lee ese programa y dónde se edita: en «Perfil y contexto» del agente, no en esta pantalla.';

/** The declared self-description is written on the agent profile, never from this catalog. */
export const DONDE_SE_ESCRIBE_EL_ROL_DECLARADO =
  'El texto con el que el agente se presenta tampoco se escribe aquí. Se redacta una sola vez en '
  + '«Perfil y contexto». Esta pantalla solo muestra la copia de diagnóstico, y no siempre llega al archivo del programa.';

/** Declared tools are authored guidance; they are never an authorization or runtime capability grant. */
export const DISTINCION_HERRAMIENTAS_Y_PERMISOS =
  'Lo que declares como herramientas en «Perfil y contexto» es una instrucción para el agente. '
  + 'No enciende programas ni concede permisos. Lo que puede hacer de verdad lo mide el programa en marcha. '
  + 'Quién puede hablar con quién se decide en «Acceso y roles».';

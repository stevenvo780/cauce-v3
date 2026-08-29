/**
 * Mapeo de cómo interactúa cada arnés con sus ficheros de configuración y rol declarado.
 */

export interface ArnesReal {
  /** El mismo identificador que `HarnessKind` en services/gateway/src/console/agent-documents/catalog.ts:4, más `hermes`. */
  id: string;
  label: string;
  /** Dónde lee su directiva, con la ruta exacta. Cadena vacía = no lee ninguna. */
  directiva: string;
  /** Por qué esa ruta es así, en una frase. Es lo que evita que alguien la «arregle» a mano. */
  detalle: string;
  /**
   * Siempre `false`, y por eso es un literal y no un booleano suelto: hoy NINGÚN documento de
   * arnés se escribe desde «Ajustes y altas», ni siquiera los que el gateway declara editables —
   * ésos se editan desde el cajón del bot, con hechos medidos dentro del contenedor.
   */
  editableDesdeAjustes: false;
  /** Dónde SÍ se toca. Un «no se puede acá» sin destino deja al operador sin salida. */
  dondeSeToca: string;
}

/**
 * El juego cerrado. `hermes` está aunque no tenga documento, y es a propósito: media flota lo usó y
 * su dueño necesita leer «este bot no lee ningún fichero de instrucciones» en vez de no encontrarlo.
 */
export const ARNESES_REALES: readonly ArnesReal[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    directiva: '<HOME>/.claude/CLAUDE.md',
    detalle: 'Si el proceso lleva `CLAUDE_CONFIG_DIR`, el fichero se mueve con él — y ese ajuste '
      + 'arrastra también el `.claude.json` de los MCP, no sólo el manual.',
    editableDesdeAjustes: false,
    dondeSeToca: 'Desde el cajón del bot en «La flota ahora», y sólo cuando el pty-agent midió el '
      + 'entorno del proceso dentro del contenedor.',
  },
  {
    id: 'codex',
    label: 'Codex',
    directiva: '<HOME>/.codex/AGENTS.md',
    detalle: 'Si el proceso lleva `CODEX_HOME`, la directiva es la de ESA carpeta. Hay alias con las '
      + 'dos, del mismo tamaño, y la de `~/.codex` es la que abriría un resolutor ingenuo.',
    editableDesdeAjustes: false,
    dondeSeToca: 'Desde el cajón del bot en «La flota ahora», con el entorno del proceso medido. Su '
      + '`config.toml` queda de sólo lectura: un TOML mal formado deja al bot sin arrancar.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    directiva: '<HOME>/.openclaw/openclaw.json → campo `agents`',
    detalle: 'No es un fichero de instrucciones: es un campo de su JSON de configuración, el mismo '
      + 'documento que lleva `auth` y `secrets`. Servirlo entero sería una fuga, así que hay que '
      + 'proyectarlo campo a campo y todavía no está hecho.',
    editableDesdeAjustes: false,
    dondeSeToca: 'Hoy por ninguna pantalla: ni acá ni en el cajón del bot. Se edita a mano dentro '
      + 'del contenedor hasta que exista la proyección campo a campo.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    directiva: '',
    detalle: 'El gateway no le resuelve ninguno: cae al `default` de `resolveAgentDocuments` y '
      + 'devuelve lista vacía (services/gateway/src/console/agent-documents/catalog.ts:317). Lo único que le llega delante de su contrato '
      + 'es el rol declarado.',
    editableDesdeAjustes: false,
    dondeSeToca: 'No hay documento que tocar. Su identidad se le da con el rol declarado, y ése se '
      + 'escribe en la pestaña «Perfil» del bot en «La flota ahora».',
  },
];

/**
 * El cierre del panel: dónde se escribe de verdad el rol declarado, y por qué le vale a los cuatro
 * arneses por igual: no lo lee el arnés de un fichero suyo, lo antepone Cauce dentro del sobre.
 */
export const DONDE_SE_ESCRIBE_EL_ROL_DECLARADO =
  'El rol declarado tampoco sale de esta pantalla: `agents.role_brief` es una proyección de sólo '
  + 'lectura y el editor genérico rechaza mutarla. Se redacta en la pestaña «Perfil» del bot en «La '
  + 'flota ahora», sobre `agent_profiles.role_summary`, y desde ahí le llega a los cuatro arneses '
  + 'por igual porque no vive en ningún fichero del bot: lo lee el servidor al entregar '
  + '(`selfRoleFromProfile`, packages/store/src/repository/agents.ts:215), viaja en el sobre como '
  + '`self_role` y el adaptador lo antepone al contrato. Por eso un bot sin directiva propia '
  + '—hermes— igual recibe identidad.';

/**
 * **Cómo funciona cada arnés DE VERDAD, y qué parte de eso gobierna esta pantalla.**
 *
 * El encargo pedía reordenar «Ajustes y altas» alrededor de cómo funciona cada arnés. Lo que hay
 * medido, y que gobierna esta tabla:
 *
 *  - **claude y codex leen un fichero de instrucciones** en disco (`CLAUDE.md`, `AGENTS.md`), en un
 *    directorio que depende de variables del proceso (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
 *  - **openclaw NO lee un fichero de instrucciones**: su directiva es un campo de
 *    `~/.openclaw/openclaw.json`, el MISMO documento donde viven `auth` y `secrets`.
 *  - **hermes no lee ninguno.** `resolveAgentDocuments()` cae al `default` y devuelve lista vacía
 *    (services/gateway/src/console/agent-documents.ts:218).
 *
 * De ahí sale la consecuencia que esta pantalla tiene que decir en voz alta: **ninguno de esos
 * cuatro sitios se toca desde «Ajustes y altas»**, y la columna `agents.harness_id` no elige entre
 * ellos (ver `campos-inertes.ts`). Lo único que esta pantalla sí gobierna —y gobierna para los
 * cuatro por igual— es el ROL DECLARADO, porque no lo lee el arnés: lo antepone Cauce dentro del
 * sobre.
 */

export interface ArnesReal {
  /** El mismo identificador que `HarnessKind` en agent-documents.ts:33, más `hermes`. */
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
      + 'devuelve lista vacía (agent-documents.ts:218). Lo único que le llega delante de su contrato '
      + 'es el rol declarado que sale de acá.',
    editableDesdeAjustes: false,
    dondeSeToca: 'No hay documento que tocar. Su identidad se le da con el rol declarado, en la '
      + 'pestaña «Roles de agente».',
  },
];

/**
 * Lo ÚNICO que «Ajustes y altas» gobierna sobre lo que el bot lee, y por qué vale para los cuatro
 * arneses por igual: no lo lee el arnés de un fichero suyo, lo antepone Cauce dentro del sobre.
 */
export const LO_QUE_AJUSTES_GOBIERNA =
  'El rol declarado (`agents.role_brief`) es lo único de esta lista que se escribe desde acá, y '
  + 'funciona con los cuatro arneses por igual porque no sale de ningún fichero del bot: lo lee el '
  + 'servidor al entregar (`selfRoleBrief`, packages/store/src/repository.ts:1821), viaja en el '
  + 'sobre como `self_role` y el adaptador lo antepone al contrato. Por eso un bot sin directiva '
  + 'propia —hermes— igual recibe identidad.';

/** Los arneses del juego cerrado que la tabla no cubre. Tiene que ser siempre `[]`. */
export function faltantesDelJuegoCerrado(
  tabla: readonly ArnesReal[], esperados: readonly string[],
): string[] {
  const cubiertos = new Set(tabla.map((arnes) => arnes.id));
  return esperados.filter((id) => !cubiertos.has(id)).sort();
}

/** Los que no leen ningún documento de instrucciones. Hoy es exactamente uno: hermes. */
export function arnesesSinDirectivaPropia(tabla: readonly ArnesReal[]): string[] {
  return tabla.filter((arnes) => arnes.directiva.trim() === '').map((arnes) => arnes.id).sort();
}

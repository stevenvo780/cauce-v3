/**
 * Catalog of fields shown on `/config` that have no effect on the system's execution.
 */

/** What reads next to the column's label. Short: shares a cell with the header. */
export const MARCA_INERTE = 'sin efecto';

/**
 * Collection → field → why it has no effect, with the citation that proves it.
 *
 * The citations are `path:line` from this repository's tree and are verified one by one: the test
 * requires that every reason carry at least one, because a "this is useless" without a citation is
 * exactly the kind of claim this work exists to avoid repeating.
 */
export const CAMPOS_INERTES: Record<string, Record<string, string>> = {
  agents: {
    harness_id:
      'No decide con qué programa corre el bot. El arnés REAL se deduce del binario en ejecución '
      + '(`harnessFromCommand`, services/gateway/src/console/agent-documents/catalog.ts:494) o de las '
      + 'capacidades del latido (`harnessFromCapabilities`, services/gateway/src/console/agent-documents/catalog.ts:503). Esta columna '
      + 'sólo se repinta en el registro (packages/store/src/repository/agents.ts:321) y se usa como último '
      + 'recurso en el inventario de documentos, que la marca NO fiable a la cara '
      + '(agent-documents.routes.ts:199).',
    home_directory:
      'No resuelve ninguna ruta. El `HOME` que vale es el del proceso del arnés, medido dentro del '
      + 'contenedor (`RuntimeFacts`, services/gateway/src/console/agent-documents/catalog.ts:19); esta '
      + 'columna sólo entra como pista cuando no hay medición, y esa respuesta viaja con su aviso de '
      + 'que no es de fiar (agent-documents.routes.ts:344).',
    state_directory:
      'No tiene lector fuera del propio registro que la repinta '
      + '(packages/store/src/repository/agents.ts:321) y de esta pantalla. El directorio de estado que el '
      + 'adaptador usa de verdad sale de su fichero local o de `CAUCE_STATE_DIR` '
      + '(packages/adapter-sdk/src/bin/config.ts:251), no de la base.',
  },
  harness_definitions: {
    command:
      'No lo lee nadie. `listAdapters` ni siquiera lo selecciona '
      + '(packages/store/src/repository/agents.ts:278) y el adaptador toma su orden de su propia tabla '
      + 'compilada (packages/adapter-sdk/src/harnesses/index.ts:12) o del `harness_command` de su '
      + 'fichero de configuración local (packages/adapter-sdk/src/bin/config.ts:179). Se guarda, se '
      + 'audita, se puede deshacer… y no cambia lo que se ejecuta.',
  },
};

/**
 * Why that field of that collection has no effect, or `undefined` if it actually does.
 *
 * `Object.hasOwn` rather than `?.` at the two steps: a collection or field the server happened to
 * name `toString` would inherit a prototype value and the table would end up painting a function as the reason.
 */
export function motivoInerte(coleccion: string, campo: string): string | undefined {
  if (!Object.hasOwn(CAMPOS_INERTES, coleccion)) return undefined;
  const campos = CAMPOS_INERTES[coleccion];
  return Object.hasOwn(campos, campo) ? campos[campo] : undefined;
}

/**
 * Which of the columns CURRENTLY BEING PAINTED are inert, in the order they were requested.
 *
 * It asks by COLUMN, not by collection, and that difference was paid for by looking at the
 * screen: the "some columns are marked as no effect" notice appeared above "Harness definitions"
 * even though none there was marked, because the test gateway publishes that collection shaped
 * like the adapters endpoint and without `command`. A banner that announces something that is not
 * there is the same defect this catalog came to fix, committed by the fixer. Asking about the
 * present keys makes the notice appear and disappear with what is actually there.
 */
export function columnasInertesDe(coleccion: string, claves: readonly string[]): string[] {
  return claves.filter((clave) => motivoInerte(coleccion, clave) !== undefined);
}

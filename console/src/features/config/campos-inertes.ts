/**
 * Catálogo de campos mostrados en `/config` que no tienen efecto en la ejecución del sistema.
 */

/** Lo que se lee junto al rótulo de la columna. Corto: comparte celda con la cabecera. */
export const MARCA_INERTE = 'sin efecto';

/**
 * Colección → campo → por qué no tiene efecto, con la cita que lo prueba.
 *
 * Las citas son `ruta:línea` del árbol de este repositorio y están verificadas una a una: la prueba
 * exige que cada motivo lleve por lo menos una, porque un «esto no sirve» sin cita es justo la clase
 * de afirmación que este trabajo existe para no repetir.
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
 * Por qué ese campo de esa colección no tiene efecto, o `undefined` si sí lo tiene.
 *
 * `Object.hasOwn` y no `?.` en los dos escalones: una colección o un campo que el servidor llamara
 * `toString` heredaría un valor del prototipo y la tabla acabaría pintando una función como motivo.
 */
export function motivoInerte(coleccion: string, campo: string): string | undefined {
  if (!Object.hasOwn(CAMPOS_INERTES, coleccion)) return undefined;
  const campos = CAMPOS_INERTES[coleccion];
  return Object.hasOwn(campos, campo) ? campos[campo] : undefined;
}

/**
 * Cuáles de las columnas QUE SE ESTÁN PINTANDO son inertes, en el orden en que se piden.
 *
 * Pregunta por COLUMNA y no por colección, y esa diferencia se pagó mirando la pantalla: el
 * aviso «algunas columnas van marcadas sin efecto» salía encima de «Harness definitions» aunque ahí
 * no hubiera ni una marcada, porque el gateway de las pruebas publica esa colección con la forma
 * del endpoint de adaptadores y sin `command`. Un cartel que anuncia algo que no está es el mismo
 * defecto que este catálogo vino a corregir, cometido por el corrector. Preguntando por las claves
 * presentes, el aviso aparece y desaparece con lo que hay.
 */
export function columnasInertesDe(coleccion: string, claves: readonly string[]): string[] {
  return claves.filter((clave) => motivoInerte(coleccion, clave) !== undefined);
}

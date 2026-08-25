import { esCampoConmutable } from './interruptores';

/**
 * **Los campos que `/config` ENSEÑA y que ningún camino de ejecución OBEDECE.**
 *
 * El encargo, textual: «evitando mantener una lógica antigua basada en campos que luego no tienen
 * efecto real». La respuesta honesta no es esconderlos —el servidor los publica y esconder un dato
 * que hay es otra forma de mentir— sino DECIRLO en la propia celda, con el motivo y con la cita de
 * dónde sale el valor que sí manda.
 *
 * Cómo se decidió cada uno: siguiendo el lector, nunca el nombre. Un campo entra acá sólo si el
 * rastreo del `SELECT` que lo consume termina en (a) nadie, o (b) un consumidor que se limita a
 * REPINTARLO —o que lo usa como pista y lo marca él mismo como no fiable—. Los campos cuyo lector
 * decide algo NO están acá, por feos que sean: quitarlos de la pantalla borraría capacidad real.
 *
 * 🔴 **Ningún campo de `CAMPOS_CONMUTABLES` puede aparecer acá.** Un interruptor promete que algo
 * va a pasar; marcarlo inerte sería la pantalla contradiciéndose en la misma celda. Lo guarda
 * `sinConmutablesInertes()`, con su control negativo por mutación en la prueba.
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
      + '(`harnessFromCommand`, services/gateway/src/console/agent-documents.ts:280) o de las '
      + 'capacidades del latido (`harnessFromCapabilities`, agent-documents.ts:301). Esta columna '
      + 'sólo se repinta en el registro (packages/store/src/repository.ts:7605) y se usa como último '
      + 'recurso en el inventario de documentos, que la marca NO fiable a la cara '
      + '(agent-documents.routes.ts:136). El 23-ago-2026 no coincidía con el binario en 5 de los 14 '
      + 'alias.',
    container_name:
      'No decide en qué contenedor se abre nada. La terminal resuelve el contenedor con '
      + '`FLEET_PLACEMENTS`, una constante del propio servidor '
      + '(services/gateway/src/terminal/authority.ts:24), copiada a propósito para no depender de '
      + 'esta tabla. Acá es intención declarada: la ejecución real sigue siendo manual '
      + '(docs/adr/006-agent-registry-and-deferred-execution.md:118).',
    runtime_user:
      'No decide con qué usuario se entra. La terminal usa lo que el pty-agent OBSERVA y, si no hay '
      + 'observación, el `runtime_user` de `FLEET_PLACEMENTS` '
      + '(services/gateway/src/terminal/plugin.ts:265), nunca esta columna.',
    home_directory:
      'No resuelve ninguna ruta. El `HOME` que vale es el del proceso del arnés, medido dentro del '
      + 'contenedor (`RuntimeFacts`, services/gateway/src/console/agent-documents.ts:44); esta '
      + 'columna sólo entra como pista cuando no hay medición, y esa respuesta viaja con su aviso de '
      + 'que no es de fiar (agent-documents.routes.ts:136). Medido: daba `/home/dev` para un alias '
      + 'que corre con `HOME=/home/claw`.',
    state_directory:
      'NO LE ENCONTRÉ LECTOR fuera del propio registro que la repinta '
      + '(packages/store/src/repository.ts:7605) y de esta pantalla. El directorio de estado que el '
      + 'adaptador usa de verdad sale de su fichero local o de `CAUCE_STATE_DIR` '
      + '(packages/adapter-sdk/src/bin/config.ts:256), no de la base.',
  },
  harness_definitions: {
    command:
      'No lo lee nadie. `listAdapters` ni siquiera lo selecciona '
      + '(packages/store/src/repository.ts:7566) y el adaptador toma su orden de su propia tabla '
      + 'compilada (packages/adapter-sdk/src/harnesses/index.ts:12) o del `harness_command` de su '
      + 'fichero de configuración local (packages/adapter-sdk/src/bin/config.ts:184). Se guarda, se '
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
 * 🔴 Pregunta por COLUMNA y no por colección, y esa diferencia se pagó mirando la pantalla: el
 * aviso «algunas columnas van marcadas sin efecto» salía encima de «Harness definitions» aunque ahí
 * no hubiera ni una marcada, porque el gateway de las pruebas publica esa colección con la forma
 * del endpoint de adaptadores y sin `command`. Un cartel que anuncia algo que no está es el mismo
 * defecto que este catálogo vino a corregir, cometido por el corrector. Preguntando por las claves
 * presentes, el aviso aparece y desaparece con lo que hay.
 */
export function columnasInertesDe(coleccion: string, claves: readonly string[]): string[] {
  return claves.filter((clave) => motivoInerte(coleccion, clave) !== undefined);
}

/**
 * Los campos que están marcados inertes Y ADEMÁS se ofrecen como interruptor. Tiene que ser
 * siempre `[]`: la lista existe para que la prueba pueda mostrar CUÁL se coló, no un booleano que
 * obligue a buscarlo a mano.
 */
export function sinConmutablesInertes(catalogo: Record<string, Record<string, string>>): string[] {
  const choques: string[] = [];
  for (const [coleccion, campos] of Object.entries(catalogo)) {
    for (const campo of Object.keys(campos)) {
      if (esCampoConmutable(coleccion, campo)) choques.push(`${coleccion}.${campo}`);
    }
  }
  return choques.sort();
}

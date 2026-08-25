import type { HarnessKind, MeasuredFactsSource, RuntimeFacts } from '../console/agent-documents.js';
import type { AgentRegistry } from './registry.js';

/**
 * Los hechos de ejecución de un alias, sacados del registro VIVO de presencia del plano de
 * terminal.
 *
 * POR QUÉ EXISTE ESTE FICHERO: hasta el 2026-08-25 el gateway construía su `MeasuredFactsSource`
 * como `{ factsFor: async () => undefined }`. La cadena de lectura entera —pty-agent, relay, ruta
 * del gateway, consola— estaba escrita y probada, y aun así el modal de directiva contestaba
 * «contenedor sin identificar»: sin hechos no hay `home`, sin `home` no hay ruta, y sin ruta no
 * hay nada que leer. No faltaba código, faltaba el cable.
 *
 * De dónde sale cada cosa: el pty-agent publica su presencia al conectarse con el relay
 * (`TAG_AGENT_HELLO`), el relay se la reenvía al gateway y `AgentRegistry` la guarda. Ahí están el
 * `harness` y —desde el 2026-08-25— el `home` del proceso del arnés.
 *
 * Lo que NO hace: inventar. Si el alias no está en el registro, o su pty-agent es anterior y no
 * publica `home`, devuelve `undefined` y quien llama enseña «no se pudo mirar» en vez de componer
 * una ruta adivinada. Un fichero equivocado se leería sin error y se escribiría sin error, que es
 * la peor de las averías posibles en esta superficie.
 */
export function hechosDelRegistro(registry: AgentRegistry): MeasuredFactsSource {
  return {
    async factsFor(tenantId: string, alias: string) {
      const observation = registry.get(tenantId, alias);
      if (observation === undefined) return undefined;
      const { presence } = observation;
      // `home` es opcional en la presencia justamente para no tirar la de un agente viejo. Aquí
      // esa ausencia sí es terminal: es el dato del que cuelga la ruta.
      if (presence.home === undefined) return undefined;
      const facts: RuntimeFacts = {
        harness: arnesDeLaPresencia(presence.harness),
        home: presence.home
      };
      // `registry`, no `measured`: esto sale de lo que el agente DECLARÓ al conectarse, no de
      // haber inspeccionado su proceso. La consola enseña la diferencia y no conviene inflarla.
      return { facts, source: 'registry' };
    }
  };
}

/**
 * El `harness` de la presencia lo declara el bundle del lanzador, no la columna de la base. Es la
 * fuente correcta —mide el proceso que de verdad corre— pero es texto libre, así que lo que no
 * reconocemos se llama `unknown` y no se fuerza a ninguno de los tres.
 */
function arnesDeLaPresencia(valor: string): HarnessKind {
  const normalizado = valor.trim().toLowerCase();
  return normalizado === 'claude' || normalizado === 'codex' || normalizado === 'openclaw'
    ? normalizado
    : 'unknown';
}

import type {
  AgentFactsProbe, FactsSource, GovernanceBatchWrite, GovernanceReadError,
  GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';

/**
 * EL HUECO DONDE EL PLANO DE TERMINAL DEJA SU SONDA, PARA QUE LA CONSOLA LA ENCUENTRE.
 *
 * ============================================================================================
 * EL PROBLEMA DE ORDEN QUE RESUELVE
 * ============================================================================================
 * Las rutas de documentos —`/v3/console/agents/:alias/documents` y su contenido— tienen que estar
 * SIEMPRE montadas: un 404 dice «este gateway no tiene la función» y eso es lo que la consola leyó
 * durante semanas como «las directivas no están en capa 2 y 3». Así que se registran en `app.ts`,
 * con el resto de `/v3/console`.
 *
 * Pero la sonda que de verdad lee el disco del contenedor —`TerminalRelayFactsProbe`— necesita el
 * cliente del terminal-relay, y ése lo construye `registerTerminalControlPlane`, que en
 * `main.ts` se registra DESPUÉS de `buildGateway`. Cuando `app.ts` monta las rutas, la sonda buena
 * todavía no existe.
 *
 * Las dos salidas obvias son peores:
 *   · Mover las rutas dentro del plugin de terminal las deja CAÍDAS —404— en cualquier despliegue
 *     que apague el terminal, que es justo el estado del que venimos.
 *   · Dejarlas con una sonda que lanza, como estaban hasta ahora, es tenerlas montadas y muertas.
 *
 * Este hueco es la tercera: las rutas se montan siempre y consultan el hueco en cada petición. Si
 * el plano de terminal se registró, encuentran la sonda real; si no, encuentran la degradada, que
 * contesta «no medido» con esas palabras.
 *
 * ============================================================================================
 * POR QUÉ SE CONSULTA EN CADA PETICIÓN Y NO SE CAPTURA AL ARRANCAR
 * ============================================================================================
 * Porque capturarla al arrancar es exactamente el fallo que esto viene a evitar: se leería el
 * hueco vacío y se guardaría la degradada para siempre, y el despliegue posterior del plano de
 * terminal no cambiaría nada. Sin un error, además: las rutas seguirían contestando «no medido»
 * con el canal ya disponible al lado.
 */

/** Sonda degradada: contesta con la verdad —que nadie ha medido— en vez de lanzar. */
const SONDA_SIN_CANAL: AgentFactsProbe = {
  async factsFor(): Promise<{ facts: RuntimeFacts; source: FactsSource } | undefined> {
    return undefined;
  },
  async readGovernanceDocument(): Promise<GovernanceReadError> {
    return {
      error: 'unavailable',
      reason: 'este gateway no tiene el plano de terminal montado, así que no hay canal hasta el '
        + 'disco del contenedor de este alias',
    };
  },
  async listMemoryDirectory(): Promise<GovernanceReadError> {
    return {
      error: 'unavailable',
      reason: 'este gateway no tiene el plano de terminal montado, así que no hay canal hasta el '
        + 'disco del contenedor de este alias',
    };
  },
  async writeGovernanceDocument(): Promise<GovernanceReadError> {
    return {
      error: 'unavailable',
      reason: 'este gateway no tiene el plano de terminal montado, así que no hay canal de escritura '
        + 'hasta el disco del contenedor de este alias',
    };
  },
  async writeGovernanceBatch(): Promise<GovernanceReadError> {
    return {
      error: 'unavailable',
      reason: 'este gateway no tiene el plano de terminal montado, así que no hay canal batch '
        + 'hasta el disco del contenedor de este alias',
    };
  },
};

/**
 * El hueco. Una instancia por gateway: se crea en `app.ts` y se decora sobre la instancia de
 * Fastify, nunca como estado de módulo — dos gateways en el mismo proceso (los tests montan
 * varios) compartirían la sonda del último en arrancar.
 */
export class SondaCompartida {
  private sonda: AgentFactsProbe = SONDA_SIN_CANAL;

  /** La instala el plano de terminal al registrarse. */
  instalar(sonda: AgentFactsProbe): void {
    this.sonda = sonda;
  }

  /** La que hay AHORA. Se pide por petición, nunca se guarda. Ver el encabezado. */
  actual(): AgentFactsProbe {
    return this.sonda;
  }

  /** `true` cuando alguien instaló una sonda real. Para poder afirmarlo en una prueba. */
  get instalada(): boolean {
    return this.sonda !== SONDA_SIN_CANAL;
  }
}

/**
 * Un `AgentFactsProbe` que delega en el hueco, resolviéndolo en CADA llamada.
 *
 * Es lo que se le pasa a `registerAgentDocumentRoutes`: desde su punto de vista es una sonda
 * normal, y ella no tiene que saber nada de este baile de orden de registro.
 */
export function sondaDiferida(hueco: SondaCompartida): AgentFactsProbe {
  return {
    factsFor: (tenantId, alias) => hueco.actual().factsFor(tenantId, alias),
    readGovernanceDocument: (path, facts, tenantId, alias) =>
      hueco.actual().readGovernanceDocument(path, facts, tenantId, alias),
    listMemoryDirectory: (memoryRoot, facts, tenantId, alias) =>
      hueco.actual().listMemoryDirectory(memoryRoot, facts, tenantId, alias),
    writeGovernanceDocument: (
      path: string,
      content: string,
      precondition: GovernanceWritePrecondition,
      facts: RuntimeFacts,
      tenantId: string,
      alias: string,
    ) => {
      const actual = hueco.actual();
      if (actual.writeGovernanceDocument === undefined) {
        return Promise.resolve({
          error: 'unavailable' as const,
          reason: 'la sonda instalada sólo sabe leer; no anuncia escritura gobernada',
        });
      }
      return actual.writeGovernanceDocument(path, content, precondition, facts, tenantId, alias);
    },
    writeGovernanceBatch: (
      writes: readonly GovernanceBatchWrite[],
      facts: RuntimeFacts,
      tenantId: string,
      alias: string,
    ) => {
      const actual = hueco.actual();
      if (actual.writeGovernanceBatch === undefined) {
        return Promise.resolve({
          error: 'unavailable' as const,
          reason: 'la sonda instalada no anuncia escritura gobernada por lote',
        });
      }
      return actual.writeGovernanceBatch(writes, facts, tenantId, alias);
    },
  };
}

/**
 * La decoración sobre la instancia de Fastify, declarada para TypeScript.
 *
 * Va en este módulo y no en el plugin de terminal porque quien la CREA es `app.ts`; el plugin sólo
 * la consume, y un tipo declarado donde se consume se desincroniza de donde se define.
 */
declare module 'fastify' {
  interface FastifyInstance {
    sondaDeDocumentos?: SondaCompartida;
  }
}

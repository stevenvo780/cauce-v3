import type {
  AgentFactsProbe, FactsSource, GovernanceBatchWrite, GovernanceReadError,
  GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';

/**
 * Sonda compartida para la resolución y lectura de documentos de gobierno.
 * Permite desacoplar el orden de registro de las rutas de consola y el plano de control
 * de terminal, resolviendo dinámicamente la sonda disponible por petición.
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
 * Contenedor mutable para la sonda de hechos del agente, decorado en la instancia de Fastify.
 */
export class SondaCompartida {
  private sonda: AgentFactsProbe = SONDA_SIN_CANAL;

  instalar(sonda: AgentFactsProbe): void {
    this.sonda = sonda;
  }

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

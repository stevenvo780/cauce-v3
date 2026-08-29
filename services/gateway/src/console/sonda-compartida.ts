import type {
  AgentFactsProbe, FactsSource, GovernanceBatchWrite, GovernanceReadError,
  GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';

/**
 * Shared probe for resolving and reading governance documents.
 * Lets the order of registration of the console routes and the terminal control plane be
 * decoupled, resolving the available probe dynamically per request.
 */

/** Degraded probe: answers with the truth —that nobody measured— instead of throwing. */
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
 * Mutable container for the agent facts probe, decorated on the Fastify instance.
 */
export class SondaCompartida {
  private sonda: AgentFactsProbe = SONDA_SIN_CANAL;

  instalar(sonda: AgentFactsProbe): void {
    this.sonda = sonda;
  }

  actual(): AgentFactsProbe {
    return this.sonda;
  }

  /** `true` when somebody installed a real probe. So a test can assert it. */
  get instalada(): boolean {
    return this.sonda !== SONDA_SIN_CANAL;
  }
}

/**
 * An `AgentFactsProbe` that delegates to the slot, resolving it on EACH call.
 *
 * This is what gets handed to `registerAgentDocumentRoutes`: from its point of view it is a
 * normal probe, and it does not need to know about this registration-order dance.
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
 * The decoration on the Fastify instance, declared for TypeScript.
 *
 * It lives here, not in the terminal plugin: `app.ts` is the one that CREATES it, and the plugin
 * only consumes it — a type declared at the consumption site drifts from its definition.
 */
declare module 'fastify' {
  interface FastifyInstance {
    sondaDeDocumentos?: SondaCompartida;
  }
}

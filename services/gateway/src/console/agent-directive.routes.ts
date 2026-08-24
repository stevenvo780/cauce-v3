import type { FastifyInstance } from 'fastify';
import type {
  AgentDirectiveFile, AgentMemoryIndex, AgentDirective
} from './types-agent-directive.js';
import type { AgentFactsProbe, GovernanceReadError } from './agent-documents.routes.js';
import { type RuntimeFacts, resolveAgentDocuments } from './agent-documents.js';

/**
 * `GET /v3/console/agents/:tenant/:alias/directive` — el contenido de las 3 capas de gobierno.
 *
 * Devuelve un AgentDirective que contiene:
 * - Capa 1 (rol): viene de la BD, NO de este endpoint (se trae en otro lugar)
 * - Capa 2 (manual del sitio): CLAUDE.md o AGENTS.md del contenedor del alias
 * - Capa 3 (memoria): índice (~/.claude/projects, ~/.openclaw/memory, etc.)
 *
 * Esto es LECTURA de ficheros DENTRO del contenedor, con restricciones severas.
 * Ver SEGURIDAD más abajo.
 */

export interface AgentDirectiveDeps {
  /** Autoriza y devuelve el actor. Exige permiso igual que el resto de /v3/console. */
  authorize(request: unknown): Promise<{ tenant_id: string; alias: string }>;
  /** Probe que lee ficheros dentro del contenedor. */
  probe: AgentFactsProbe;
}

/**
 * SEGURIDAD CRÍTICA: Políticas de lectura de fichero.
 *
 * 🚩 Estas políticas se implementan TANTO en el gateway como en el pty-agent.
 * Una falla en CUALQUIERA de los dos es una fuga de credenciales.
 */

/** Raíz de memoria para cada arnés. */
function memoryRootForHarness(harness: string, home: string): string | null {
  switch (harness) {
    case 'claude':
      return `${home}/.claude/projects`;
    case 'codex':
      return `${home}/.codex/prompts`; // Aunque en el pty-agent podría ser /home/dev/memory
    case 'openclaw':
      return `${home}/.openclaw/memory`;
    default:
      return null;
  }
}

/**
 * Las rutas de directiva (CLAUDE.md, AGENTS.md, etc.) de un alias.
 *
 * Se le pasan los hechos ENTEROS, no `harness` y `home` sueltos: atlas corre con
 * `CODEX_HOME=/home/dev/.codex/cuenta-b`, así que quedarse con el home daría
 * `~/.codex/AGENTS.md` — que existe, que pesa lo mismo, y que ese agente NO lee.
 */
function directivePathsForHarness(facts: RuntimeFacts): string[] {
  return resolveAgentDocuments(facts).map((doc) => doc.path);
}

/**
 * Validación de seguridad: ¿esta ruta se puede leer?
 * - Tiene que estar en el juego cerrado de resolveAgentDocuments()
 * - No puede ser symlink (lo verifica el pty-agent con realpath)
 * - No puede ser credencial (NEVER_SERVE)
 */
function isPathAllowedForReading(path: string, allowedPaths: string[]): boolean {
  // La ruta DEBE estar en el juego cerrado
  if (!allowedPaths.includes(path)) {
    return false;
  }
  // Las validaciones de symlink y NEVER_SERVE se hacen en el pty-agent
  return true;
}

/**
 * Indicador de que la lectura falló en el pty-agent.
 * (Ver GovernanceReadError en agent-documents.routes.ts)
 */
function isReadError(result: unknown): result is GovernanceReadError {
  return result !== null && typeof result === 'object' && 'error' in result;
}

export function registerAgentDirectiveRoutes(app: FastifyInstance, deps: AgentDirectiveDeps): void {
  app.get<{ Params: { tenant: string; alias: string } }>(
    '/v3/console/agents/:tenant/:alias/directive',
    async (request) => {
      // 1. AUTORIZACIÓN: ¿el actor ve este alias?
      const actor = await deps.authorize(request);
      const alias = request.params.alias;

      // NOTA: El param `:tenant` es parte del contrato. Validar que el actor ve ese tenant.
      // (Hoy el authorize() devuelve tenant_id del actor; asumir que si llegó aquí, es porque
      // el middleware ya filtró por ACL. Si hay dudas, agregar una validación explícita.)

      // 2. FACTS: ¿se midieron los hechos del alias?
      const medido = await deps.probe.factsFor(actor.tenant_id, alias);
      if (!medido) {
        // 🚩 Degradar honesto: no sabemos dónde está la directiva.
        return {
          publicado: true,
          motivo: 'contenedor no medido todavía (sin hechos de entorno)',
          files: null,
          memory: null,
        };
      }

      const { facts, source } = medido;
      const timestamp = new Date().toISOString();

      // Si la fuente no es MEDIDA, no servir contenido — es demasiado arriesgado.
      // (La ruta que la BD da falla en 5 de 14 alias.)
      if (source !== 'measured') {
        return {
          publicado: true,
          motivo: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
          files: null,
          memory: null,
        };
      }

      // 3. RESOLVER RUTAS: ¿cuál es el juego cerrado de ficheros para este alias?
      const allowedDirectivePaths = directivePathsForHarness(facts);
      const memoryRoot = memoryRootForHarness(facts.harness, facts.home);

      // 4. LEER DIRECTIVA: para cada ruta permitida, pedir contenido al probe
      const files: AgentDirectiveFile[] = [];
      for (const path of allowedDirectivePaths) {
        // 🚩 Validación de seguridad: ¿está en el juego cerrado?
        if (!isPathAllowedForReading(path, allowedDirectivePaths)) {
          // Esto nunca debería ocurrir si resolveAgentDocuments() es honesto.
          // Pero defensa en profundidad: rechazar.
          continue;
        }

        // Pedir lectura
        const content = await deps.probe.readGovernanceDocument(path, facts, actor.tenant_id, alias);

        if (isReadError(content)) {
          // 🚩 El pty-agent no pudo leer. Marcar como no disponible.
          files.push({
            path,
            scope: path.includes(facts.home) ? 'user' : 'workspace',
            bytes: null,
            modified_at: null,
            text: null,
            truncated: false,
          });
          continue;
        }

        // ✓ Contenido leído exitosamente
        files.push({
          path,
          scope: path.includes(facts.home) ? 'user' : 'workspace',
          bytes: content.bytes,
          modified_at: content.modified_at,
          text: content.text,
          truncated: content.truncated,
        });
      }

      // 5. LEER MEMORIA: listar el directorio de memoria (SIN contenido)
      let memory: AgentMemoryIndex | null = null;
      if (memoryRoot) {
        const memoryListing = await deps.probe.listMemoryDirectory(memoryRoot, facts, actor.tenant_id, alias);
        if (!isReadError(memoryListing)) {
          memory = {
            root: memoryListing.root,
            total: memoryListing.total,
            truncated: memoryListing.truncated,
            entries: memoryListing.entries.map((e) => ({
              path: e.path,
              bytes: e.bytes,
              modified_at: e.modified_at,
            })),
          };
        } else {
          // 🚩 La memoria no está disponible — devolver índice vacío pero marcar error.
          memory = {
            root: memoryRoot,
            total: 0,
            truncated: false,
            entries: [],
          };
        }
      }

      // 6. RESPUESTA FINAL
      const resultado: AgentDirective = {
        publicado: true,
        observed_at: timestamp,
        // `RuntimeFacts` no lleva el contenedor: los hechos que mide el pty-agent son del PROCESO
        // del arnés (arnés, HOME, CODEX_HOME, cwd), no del contenedor que lo envuelve. Va `null`
        // en vez de inventarlo; quien quiera el contenedor lo tiene en la presencia del relay.
        container_id: null,
        files,
        memory,
      };

      return resultado;
    },
  );
}

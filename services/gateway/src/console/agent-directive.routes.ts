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

/**
 * La respuesta cuando la lectura NO ocurrió, o `undefined` si sí ocurrió.
 *
 * Está fuera del handler para poder probarla sola, y porque los dos caminos degradados tenían
 * el mismo defecto: devolvían `publicado: true` con `files: null` sin decir en ningún campo que
 * no se había mirado nada. Quien pinta lo interpretaba como «se miró y no hay» y afirmaba que el
 * alias arranca sin manual — falso en 11 de los 12 alias medidos dentro de sus contenedores el
 * 24-ago-2026.
 *
 * `publicado` responde «¿existe la ruta?». `medido` responde «¿ocurrió la lectura?». Son
 * preguntas distintas y hacía falta la segunda.
 */
export function construirRespuestaDegradada(
  source: 'measured' | 'registry' | 'database' | undefined,
): AgentDirective | undefined {
  if (source === undefined) {
    return {
      publicado: true,
      medido: false,
      motivo: 'contenedor no medido todavía (sin hechos de entorno)',
      files: null,
      memory: null,
    };
  }
  if (source !== 'measured') {
    // La ruta que da el registro falla en 5 de 14 alias: servir contenido desde ahí abriría el
    // fichero de OTRO agente sin dar un solo error. Se declara no medida y no se sirve nada.
    return {
      publicado: true,
      medido: false,
      motivo: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
      files: null,
      memory: null,
    };
  }
  return undefined;
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
      const degradada = construirRespuestaDegradada(medido?.source);
      // Los dos caminos degradados —sin hechos, y con hechos deducidos del registro— dicen ahora
      // `medido: false`, para que quien pinta no tenga que adivinarlo por la forma de los datos.
      if (!medido || degradada) return degradada;

      const { facts } = medido;
      const timestamp = new Date().toISOString();

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
          /*
           * La memoria NO se pudo listar. Antes esto devolvía `{total: 0, entries: []}`, y ese
           * cero viajaba hasta la pantalla como «miró y este alias no tiene memoria escrita».
           * Es la misma mentira que la capa 2: un cero que nadie contó. Medido el 23-ago, `zeus`
           * tiene 18.212 ficheros en `~/.claude/projects` y `janus` 639.
           *
           * `null` significa «no se miró», y la consola ya sabe pintar eso con su motivo.
           */
          memory = null;
        }
      }

      // 6. RESPUESTA FINAL
      const resultado: AgentDirective = {
        publicado: true,
        // Este es el único camino en el que la lectura ocurrió de verdad, sobre hechos medidos
        // dentro del contenedor. Sólo aquí la pantalla puede afirmar una ausencia.
        medido: true,
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

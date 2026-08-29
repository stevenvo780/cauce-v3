import type { FastifyInstance } from 'fastify';
import { TextDecoder } from 'node:util';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import type {
  AgentDirectiveFile, AgentMemoryIndex, AgentDirective
} from './types-agent-directive.js';
import type { AgentFactsProbe, GovernanceReadError } from './agent-documents.routes.js';
import {
  codexProjectDocMaxBytes, effectiveManualPaths, measuredCodexProjectDocumentConfig,
  memoryRootForHarness, type EffectiveManualPath,
} from './agent-documents.js';

/** Public compatibility: the single source lives next to RuntimeFacts. */
export { memoryRootForHarness };

/**
 * `GET /v3/console/agents/:tenant/:alias/directive` — the contents of the 3 governance layers.
 *
 * Returns an AgentDirective containing:
 * - Layer 1 (role): comes from the DB, NOT from this endpoint (it is fetched elsewhere)
 * - Layer 2 (site manual): CLAUDE.md or AGENTS.md from the alias's container
 * - Layer 3 (memory): index (~/.claude/projects, ~/.openclaw/memory, etc.)
 *
 * This is a READ of files INSIDE the container, with strict restrictions.
 * See SECURITY below.
 */

export interface AgentDirectiveDeps {
  /** Authorises the requested canonical identity; `undefined` does not reveal whether it is missing or hidden. */
  authorize(
    request: unknown,
    requested: { tenant_id: string; alias: string },
  ): Promise<{ tenant_id: string; alias: string } | undefined>;
  /** Probe that reads files inside the container. */
  probe: AgentFactsProbe;
  /** Total budget for manuals + memory. Injectable only for deterministic tests. */
  readBudgetMs?: number;
}

/** The relay has its own timeouts; this one bounds the endpoint's overall operation. */
export const DIRECTIVE_READ_BUDGET_MS = 5_000;
const DIRECTIVE_READ_CONCURRENCY = 3;

/**
 * CRITICAL SECURITY: File-read policies.
 *
 * 🚩 These policies are enforced BOTH in the gateway and in the pty-agent.
 * A failure in EITHER one is a credential leak.
 */

/**
 * Directive paths for the alias, resolved from environment facts.
 */
/**
 * Security check: is this path allowed to be read?
 * - Must be in the closed set returned by resolveAgentDocuments()
 * - Must not be a symlink (the pty-agent verifies with realpath)
 * - Must not be a credential (NEVER_SERVE)
 */
function isPathAllowedForReading(path: string, allowedPaths: string[]): boolean {
  // The path MUST be in the closed set
  if (!allowedPaths.includes(path)) {
    return false;
  }
  // Symlink and NEVER_SERVE checks are performed in the pty-agent
  return true;
}

/**
 * Indicator that the read failed in the pty-agent.
 * (See GovernanceReadError in agent-documents.routes.ts)
 */
function isReadError(result: unknown): result is GovernanceReadError {
  return result !== null && typeof result === 'object' && 'error' in result;
}

type PublishedReadError = Omit<GovernanceReadError, 'error'> & {
  readonly error: Exclude<GovernanceReadError['error'], 'not_found'>;
};

function failedManual(
  manual: EffectiveManualPath,
  failure: PublishedReadError,
): AgentDirectiveFile {
  return {
    path: manual.path,
    scope: manual.scope,
    precedence: manual.precedence,
    sha: null,
    bytes: null,
    modified_at: null,
    text: null,
    truncated: false,
    error: failure.error,
    reason: failure.reason,
  };
}

/** Trims by bytes without introducing U+FFFD when the boundary falls inside a UTF-8 character. */
function utf8Prefix(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, 'utf8');
  if (raw.byteLength <= maxBytes) return text;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.max(0, maxBytes); end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(raw.subarray(0, end));
    } catch {
      // A UTF-8 character takes at most four bytes; the previous boundary is tried.
    }
  }
  return '';
}

/**
 * Builds the degraded response when facts do not come from a direct measurement of the
 * container (`source === 'measured'`), or `undefined` if the facts are measured.
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
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'contenedor no medido todavía (sin hechos de entorno)',
      },
    };
  }
  if (source !== 'measured') {
    // If the source is not 'measured', the accuracy of the runtime paths is not guaranteed.
    return {
      publicado: true,
      medido: false,
      motivo: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
      files: null,
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
      },
    };
  }
  return undefined;
}

export function registerAgentDirectiveRoutes(app: FastifyInstance, deps: AgentDirectiveDeps): void {
  app.get<{ Params: { tenant: string; alias: string } }>(
    '/v3/console/agents/:tenant/:alias/directive',
    async (request, reply) => {
      const tenant = TenantSchema.safeParse(request.params.tenant);
      const alias = AliasSchema.safeParse(request.params.alias);
      if (!tenant.success || !alias.success) {
        return reply.code(400).send({ error: 'invalid_input', message: 'tenant or alias is invalid' });
      }
      const requested = { tenant_id: tenant.data, alias: alias.data };
      const target = await deps.authorize(request, requested);
      if (!target || target.tenant_id !== requested.tenant_id || target.alias !== requested.alias) {
        return reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      }

      const medido = await deps.probe.factsFor(target.tenant_id, target.alias);
      const degradada = construirRespuestaDegradada(medido?.source);
      // Degraded responses are marked with measured: false.
      if (!medido || degradada) return degradada;

      const { facts } = medido;
      if (facts.harness === 'unknown') {
        const motivo = 'el arnés medido no está soportado por la lectura de directivas';
        return {
          publicado: true,
          medido: false,
          motivo,
          files: null,
          memory: { root: null, error: 'unavailable', reason: motivo },
        } satisfies AgentDirective;
      }
      const timestamp = new Date().toISOString();

      const manuals = effectiveManualPaths(facts);
      const allowedDirectivePaths = manuals.map((manual) => manual.path);
      const memoryRoot = memoryRootForHarness(facts);
      const abort = new AbortController();
      let abortReason: 'timeout' | 'cancelled' = 'cancelled';
      const budgetMs = Number.isSafeInteger(deps.readBudgetMs)
        && (deps.readBudgetMs ?? 0) >= 1 && (deps.readBudgetMs ?? 0) <= 60_000
        ? deps.readBudgetMs!
        : DIRECTIVE_READ_BUDGET_MS;
      const globalFailure = (): PublishedReadError => abortReason === 'timeout'
        ? {
          error: 'timeout',
          reason: `la lectura completa excedió su presupuesto global de ${budgetMs} ms`,
        }
        : {
          error: 'cancelled',
          reason: 'el cliente cerró la petición antes de completar la medición',
        };
      let resolveAbort!: (failure: GovernanceReadError) => void;
      const aborted = new Promise<GovernanceReadError>((resolve) => {
        resolveAbort = resolve;
      });
      abort.signal.addEventListener('abort', () => resolveAbort(globalFailure()), { once: true });
      const stop = (reason: 'timeout' | 'cancelled'): void => {
        if (abort.signal.aborted) return;
        abortReason = reason;
        abort.abort();
      };
      const abortOnClose = (): void => {
        if (!reply.raw.writableEnded) stop('cancelled');
      };
      request.raw.once('aborted', abortOnClose);
      reply.raw.once('close', abortOnClose);
      const budgetTimer = setTimeout(() => stop('timeout'), budgetMs);
      budgetTimer.unref?.();

      const readManual = async (
        manual: EffectiveManualPath,
      ): Promise<AgentDirectiveFile | null> => {
        if (abort.signal.aborted) return failedManual(manual, globalFailure());
        if (!isPathAllowedForReading(manual.path, allowedDirectivePaths)) return null;
        let content: Awaited<ReturnType<AgentFactsProbe['readGovernanceDocument']>>;
        try {
          content = await Promise.race([
            deps.probe.readGovernanceDocument(
              manual.path, facts, target.tenant_id, target.alias, abort.signal,
            ),
            aborted,
          ]);
        } catch (error) {
          content = {
            error: 'unknown',
            reason: `la lectura falló: ${error instanceof Error ? error.message : 'sin detalle'}`,
          };
        }
        if (isReadError(content)) {
          if (content.error === 'not_found') return null;
          return failedManual(manual, { error: content.error, reason: content.reason });
        }
        return {
          path: manual.path,
          scope: manual.scope,
          precedence: manual.precedence,
          sha: content.sha,
          bytes: content.bytes,
          modified_at: content.modified_at,
          text: content.text,
          truncated: content.truncated,
        };
      };

      // Memory is independent from the manuals. Starting them together keeps the endpoint under
      // a single budget; three files + one index respect the relay's four-READ limit.
      const memoryPromise: Promise<AgentMemoryIndex> = memoryRoot === null
        ? Promise.resolve({
          root: null,
          error: 'unavailable',
          reason: 'el arnés medido no publica una raíz exacta de memoria',
        })
        : (async () => {
          let listing: Awaited<ReturnType<AgentFactsProbe['listMemoryDirectory']>>;
          try {
            listing = await Promise.race([
              deps.probe.listMemoryDirectory(
                memoryRoot, facts, target.tenant_id, target.alias, abort.signal,
              ),
              aborted,
            ]);
          } catch (error) {
            listing = {
              error: 'unknown',
              reason: `el índice falló: ${error instanceof Error ? error.message : 'sin detalle'}`,
            };
          }
          if (isReadError(listing)) {
            return { root: memoryRoot, error: listing.error, reason: listing.reason };
          }
          return {
            root: listing.root,
            total: listing.total,
            observed_at_least: listing.observed_at_least,
            truncated: listing.truncated,
            entries: listing.entries.map((entry) => ({
              path: entry.path,
              bytes: entry.bytes,
              modified_at: entry.modified_at,
            })),
          };
        })();

      try {
        let files: AgentDirectiveFile[];
        if (facts.harness === 'codex') {
          // Codex picks one candidate per layer and applies an aggregate cap to project manuals.
          // That is why this path remains sequential: prefetching fallbacks would falsify the order.
          files = [];
          const projectLimit = codexProjectDocMaxBytes(facts);
          let projectBytes = 0;
          for (let index = 0; index < manuals.length; index += 1) {
            const manual = manuals[index]!;
            if (manual.scope === 'workspace' && projectBytes >= projectLimit) break;
            const read = await readManual(manual);
            if (read === null) continue;
            if (read.error !== undefined) {
              files.push(read);
              if (abort.signal.aborted) {
                for (const remaining of manuals.slice(index + 1)) {
                  files.push(failedManual(remaining, globalFailure()));
                }
                break;
              }
              if (manual.selection === 'first_existing') {
                while (manuals[index + 1]?.group === manual.group) index += 1;
              }
              continue;
            }
            // A zero-byte override does not shadow AGENTS.md nor the configured fallback.
            if (manual.selection === 'first_existing' && read.bytes === 0) continue;
            let effectiveRead = read;
            if (manual.scope === 'workspace') {
              const remaining = Math.max(0, projectLimit - projectBytes);
              const originalText = read.text ?? '';
              effectiveRead = {
                ...read,
                text: utf8Prefix(originalText, remaining),
                truncated: Boolean(read.truncated)
                || (read.bytes ?? 0) > remaining
                || Buffer.byteLength(originalText, 'utf8') > remaining,
              };
              projectBytes += Math.min(read.bytes ?? 0, remaining);
            }
            files.push(effectiveRead);
            if (manual.selection === 'first_existing') {
              while (manuals[index + 1]?.group === manual.group) index += 1;
            }
          }
        } else {
          // Claude can have 3 files per layer. Three workers preserve output order and let
          // a global budget cut several hung probes at once.
          const results = new Array<AgentDirectiveFile | null | undefined>(manuals.length);
          let next = 0;
          const worker = async (): Promise<void> => {
            while (next < manuals.length) {
              const index = next;
              next += 1;
              results[index] = await readManual(manuals[index]!);
            }
          };
          await Promise.all(Array.from(
            { length: Math.min(DIRECTIVE_READ_CONCURRENCY, manuals.length) },
            () => worker(),
          ));
          files = results.filter((item): item is AgentDirectiveFile => item != null);
        }

        const memory = await memoryPromise;
        const measuredCodexConfig = measuredCodexProjectDocumentConfig(facts);
        return {
          publicado: true,
          // This is the only path where the read actually happened, over measured facts
          // inside the container. Only here can the screen assert an absence.
          medido: true,
          observed_at: timestamp,
          container_id: facts.containerId ?? null,
          files,
          manual_order: facts.harness === 'codex'
            ? 'codex_precedence'
            : facts.harness === 'claude'
              ? 'claude_load_order'
              : 'workspace_only',
          context_coverage: 'standard_manuals',
          context_limitations: facts.harness === 'claude'
            ? ['Las reglas `.claude/rules/*.md` no se enumeran en esta versión; esta vista no acredita el contexto completo de Claude.']
            : facts.harness === 'codex' && measuredCodexConfig === undefined
              ? [
                'El agente no publicó la proyección conjunta de `project_doc_fallback_filenames` '
                  + `y \`project_doc_max_bytes\`; se aplicó el límite conservador de ${codexProjectDocMaxBytes(facts)} bytes `
                  + 'y sólo los nombres estándar.',
              ]
              : [],
          memory,
        } satisfies AgentDirective;
      } finally {
        clearTimeout(budgetTimer);
        request.raw.off('aborted', abortOnClose);
        reply.raw.off('close', abortOnClose);
      }
    },
  );
}

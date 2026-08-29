import {
  measuredCodexProjectDocumentConfig, type MeasuredFactsSource, type RuntimeFacts,
} from '../console/agent-documents.js';
import type { FactsSource } from '../console/agent-documents.routes.js';
import type { AgentRegistry } from './registry.js';

/**
 * Adapter to extract measured environment facts from the presence reported by agents.
 */

/** Harnesses whose governing files this path knows how to resolve. */
const ARNESES_CONOCIDOS = ['claude', 'codex', 'openclaw', 'hermes'] as const;

function arnesConocido(valor: string): valor is RuntimeFacts['harness'] {
  return (ARNESES_CONOCIDOS as readonly string[]).includes(valor);
}

function rutaCanonica(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !valor.startsWith('/') || valor === '/'
      || valor.length > 4096 || valor.includes('\0')) return false;
  return !valor.split('/').slice(1)
    .some((segmento) => segmento === '' || segmento === '.' || segmento === '..');
}

/**
 * Facts measured from what the pty-agent publishes in its presence.
 * Returns `undefined` if the registry is unavailable, is stale, or lacks
 * the required canonical paths.
 */
export function hechosDelRegistro(registry: AgentRegistry): MeasuredFactsSource {
  return {
    async factsFor(tenantId: string, alias: string) {
      const observacion = registry.get(tenantId, alias);
      if (!observacion || observacion.stale) return undefined;

      const {
        harness, home, runtime_facts_observed: runtimeFactsObserved,
        codex_home: codexHome, claude_config_dir: claudeConfigDir,
        openclaw_workspace: openclawWorkspace, cwd, workspace_root: workspaceRoot,
        project_root: projectRoot, project_doc_max_bytes: projectDocMaxBytes,
        project_doc_fallback_filenames: projectDocFallbackFilenames,
      } = observacion.presence;
      // Validates presence of environment facts, recognized harness, and canonical paths.
      if (runtimeFactsObserved !== true) return undefined;
      if (!arnesConocido(harness)) return undefined;
      if (!rutaCanonica(home)) return undefined;
      if ((cwd !== undefined && !rutaCanonica(cwd))
          || (workspaceRoot !== undefined && (!rutaCanonica(workspaceRoot) || cwd === undefined
            || (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}/`))))
          || (projectRoot !== undefined && (!rutaCanonica(projectRoot) || cwd === undefined
            || (cwd !== projectRoot && !cwd.startsWith(`${projectRoot}/`))
            || (workspaceRoot !== undefined && projectRoot !== workspaceRoot
              && !projectRoot.startsWith(`${workspaceRoot}/`))))) return undefined;
      if ((harness === 'codex' && !rutaCanonica(codexHome))
          || (harness === 'claude' && !rutaCanonica(claudeConfigDir))
          || (harness === 'openclaw' && !rutaCanonica(openclawWorkspace))
          || (harness === 'hermes' && (!rutaCanonica(cwd) || !rutaCanonica(projectRoot)))) {
        return undefined;
      }

      // Explicit mapping of presence fields to RuntimeFacts.
      const facts: RuntimeFacts = {
        harness,
        home,
        generation: observacion.presence.generation,
        containerId: observacion.presence.container_id,
        modes: [...observacion.presence.modes],
        ...(codexHome === undefined ? {} : { codexHome }),
        ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }),
        ...(openclawWorkspace === undefined ? {} : { openclawWorkspace }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(projectRoot === undefined ? {} : { projectRoot }),
      };
      const codexConfig = measuredCodexProjectDocumentConfig({
        ...facts,
        ...(projectDocMaxBytes === undefined ? {} : { projectDocMaxBytes }),
        ...(projectDocFallbackFilenames === undefined
          ? {} : { projectDocFallbackFilenames }),
      });
      const completeFacts: RuntimeFacts = codexConfig === undefined ? facts : {
        ...facts,
        projectDocMaxBytes: codexConfig.maxBytes,
        projectDocFallbackFilenames: [...codexConfig.fallbackFilenames],
      };
      const source: FactsSource = 'measured';
      return { facts: completeFacts, source };
    }
  };
}

import {
  measuredCodexProjectDocumentConfig, type MeasuredFactsSource, type RuntimeFacts,
} from '../console/agent-documents.js';
import type { FactsSource } from '../console/agent-documents.routes.js';
import type { AgentRegistry } from './registry.js';

/**
 * LOS HECHOS MEDIDOS, SACADOS DE LA PRESENCIA QUE EL PROPIO AGENTE PUBLICA.
 *
 * ============================================================================================
 * POR QUÉ ESTO ESTABA VACÍO
 * ============================================================================================
 * `MeasuredFactsSource` existía, `TerminalRelayFactsProbe` la consumía y toda la vía de documentos
 * colgaba de ella. Y en producción se inyectaba `{ factsFor: async () => undefined }`: un doble
 * que dice «nadie ha medido nada» SIEMPRE. Por eso `GET /documents` contestaba con rutas deducidas
 * del registro y `editable: false`, y el contenido no se podía ni pedir.
 *
 * El motivo real estaba escrito en el propio plugin: *«el pty-agent conoce su `home` y su
 * `harness` por el bundle con el que arranca, pero no los publica ni en el hello ni en la
 * presencia, así que no hay ninguna fuente en producción»*. El `harness` sí viajaba; el `home` no.
 * Ahora viaja, y este módulo es lo que faltaba en medio.
 *
 * ============================================================================================
 * POR QUÉ DEL AGENTE Y NO DEL REGISTRO DE LA BASE
 * ============================================================================================
 * Porque el registro se equivoca. Medido el 23-ago-2026: `agents.harness_id` era incorrecto en
 * 5 de los 14 alias. Resolver `~/.claude/CLAUDE.md` con un `harness` equivocado no da «no se pudo
 * leer»: da el fichero de OTRO arnés, servido como si fuera el bueno. El agente que corre dentro
 * del contenedor es la única pieza que sabe con qué `$HOME` y con qué binario arrancó.
 *
 * Es la misma regla que gobierna todo este trabajo: quien tiene el dato delante es quien lo dice.
 *
 * ============================================================================================
 * QUÉ SE NIEGA A CONTESTAR, Y ES LA MITAD DEL VALOR
 * ============================================================================================
 * Devuelve `undefined` —o sea «no medido», que es lo que la pantalla ya sabe pintar— en cuanto
 * falta cualquier pieza o la medición está vieja. Un hecho a medias es peor que ninguno: con él,
 * la consola pasaría de decir honestamente «no se miró» a servir un fichero equivocado con cara
 * de medido.
 */

/** Los arneses cuyos ficheros de gobierno esta vía sabe resolver. */
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
 * Hechos medidos a partir de lo que el pty-agent publica en su presencia.
 *
 * `stale` cuenta como no medido. Un agente que dejó de reportar puede haberse reiniciado con otro
 * `$HOME` —es exactamente lo que pasa al recrear un contenedor—, y servir la ruta de antes sería
 * afirmar sobre un proceso que ya no existe.
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
      // Las dos condiciones por separado y no en una: un agente viejo no manda `home` y un agente
      // nuevo puede correr un arnés que esta vía no sabe resolver. Son dos ausencias distintas y
      // ninguna de las dos autoriza a inventar la otra.
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

      /*
       * El cable de presencia usa snake_case y RuntimeFacts usa camelCase. No propagar estos tres
       * campos era peor que perderlos: `resolveAgentDocuments()` caía silenciosamente a
       * `~/.codex`/`~/.claude` y devolvía un fichero real, pero de otra cuenta del mismo HOME.
       * Se mapean de forma explícita; un spread conservaría las claves con el nombre equivocado.
       */
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

import { useOptionalConsoleAccess } from '../../api/console-access';
import { useResource } from '../../api/use-resource';
import { listTerminalTargets } from '../../features/terminal/api';
import { permissionState } from '../../lib';
import { agentActions, agentKey, type AgentAction, type AgentActionId, type AgentRef } from './agent-actions';
import { useAgentPreferences } from './preferences-context';

const OUTSIDE_SHELL = 'Disponible dentro de la consola completa.';
const NO_PTY = 'El servidor no declaró una terminal para este agente.';

/** The action list for one agent plus what running each non-link action does. */
export function useAgentActions(agent: AgentRef, omit?: readonly AgentActionId[]) {
  const preferences = useAgentPreferences();
  const access = useOptionalConsoleAccess();
  const key = agentKey(agent);
  const inventory = useResource('agent-actions-pty-targets', listTerminalTargets).data?.items;
  const ptyMissing = inventory ? !inventory.some((target) => target.tenant_id === agent.tenantId && target.alias === agent.alias) : false;
  const actions = agentActions(agent, {
    favorite: preferences?.status === 'ready' ? preferences.favorites.has(key) : undefined,
    favoriteReason: preferences === null ? OUTSIDE_SHELL
      : preferences.status === 'error' ? `No se pudieron leer los favoritos: ${preferences.error ?? 'sin detalle'}` : undefined,
    appearance: permissionState(access?.error ? undefined : access?.data, 'config.write'),
    appearanceUnavailable: preferences === null ? OUTSIDE_SHELL : undefined,
    ptyUnavailable: ptyMissing ? NO_PTY : undefined,
    omit,
  });

  function run(action: AgentAction): void {
    if (action.disabled || !preferences) return;
    if (action.id === 'favorite') preferences.toggleFavorite(agent);
    else if (action.id === 'appearance') preferences.customize(agent);
    else if (action.id === 'copy') {
      const clipboard = (navigator as Partial<Navigator>).clipboard;
      const write = clipboard ? clipboard.writeText(agent.alias) : Promise.reject(new Error('sin portapapeles'));
      write.then(
        () => { preferences.notify(`Alias «${agent.alias}» copiado.`); },
        () => { preferences.notify('No se pudo copiar: el navegador no dio acceso al portapapeles.', 'danger'); },
      );
    }
  }

  return { actions, run };
}

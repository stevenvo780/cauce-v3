import { Menu } from '@base-ui/react/menu';
import { Cpu, Ellipsis, Monitor } from 'lucide-react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { AgentOrb } from '../../components/AgentOrb';
import { MENU_ITEM, MENU_POPUP, Pill } from '../../components/kit';
import { onNavClick } from '../../router';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentView, respondsAnswer, subtituloDeAgente, type SheetTab } from './agent-view';
import { GroupChips } from './AgentSheetTabs';
import { useLiveAgent } from './use-live-agent';
import type { SettingsAgent } from './settings-model';

const KEBAB = 'absolute top-2.5 right-2.5 grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-fg data-[popup-open]:bg-muted-bg data-[popup-open]:text-fg';

/** One tile per agent: whether it answers and where it runs at a glance; the whole tile opens its sheet. */
export function AgentRow({ agent, snapshot, hosts, writeBlock, retireBlock, onOpen }: {
  agent: SettingsAgent;
  /** Why writing is not allowed for this account (RBAC), or undefined when it is. */
  writeBlock?: string | undefined;
  /** Why the fleet executor cannot retire agents, or undefined when it can (or is not known yet). */
  retireBlock?: string | undefined;
  snapshot: ConfigurationSnapshot;
  hosts: FleetHost[] | undefined;
  onOpen: (tab?: SheetTab, kind?: 'retire' | 'remove') => void;
}) {
  const view = agentView(agent, snapshot, hosts);
  const live = useLiveAgent(agent.tenantId, agent.alias);
  const responds = respondsAnswer(live?.state);
  const href = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}?view=context`;
  const memberOnly = !agent.registered;
  const retiringBlock = writeBlock ?? retireBlock;
  return <li className={`relative flex min-w-0 rounded-xl border border-line bg-surface shadow-card transition-colors hover:border-line-strong hover:bg-subtle ${memberOnly ? 'opacity-75' : ''}`}>
    <button type="button" data-agent-tile={view.ref} onClick={() => { onOpen(); }} aria-label={`Abrir agente ${view.ref}`}
      className="grid w-full min-w-0 cursor-pointer content-start gap-3 rounded-xl border-0 bg-transparent p-4 pr-12 text-left text-fg outline-none focus-visible:outline-2 focus-visible:outline-brand">
      <span className="flex min-w-0 items-center gap-3">
        <AgentOrb seed={view.ref} size={40} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="truncate text-sm" title={agent.name}>{agent.name}</strong>
          <span className="truncate text-xs text-muted" title={view.ref}>{subtituloDeAgente(agent, snapshot)}</span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {memberOnly ? null : <Pill tone={responds.tone} title={live?.reason ?? responds.detail}>{responds.label}</Pill>}
        {memberOnly || view.state.tone !== 'ok' ? <Pill tone={view.state.tone} className="max-w-full truncate">{view.state.label}</Pill> : null}
      </span>
      {memberOnly ? null : <span className="grid gap-1 text-xs text-fg-2">
        <span className="flex min-w-0 items-center gap-1.5" title="Computadora donde corre">
          <Monitor size={13} aria-hidden="true" className="shrink-0 text-muted" /><span className="truncate">{view.hostName}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5" title="Programa del agente">
          <Cpu size={13} aria-hidden="true" className="shrink-0 text-muted" /><span className="truncate">{agent.harness ?? 'Programa sin declarar'}</span>
        </span>
      </span>}
      <span className="flex min-h-5 flex-wrap items-center gap-1">
        <GroupChips agent={agent} max={3} />
      </span>
    </button>
    {memberOnly ? null : <Menu.Root>
      <Menu.Trigger aria-label={`Acciones de ${view.ref}`} title={`Acciones de ${view.ref}`} className={KEBAB}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-[60]">
          <Menu.Popup className={`${MENU_POPUP} w-56`}>
            <Menu.LinkItem href={href} closeOnClick className={MENU_ITEM} aria-label={`Perfil y contexto de ${view.ref}`}
              onClick={(event) => { onNavClick(event, href); }}>Perfil y contexto</Menu.LinkItem>
            <Menu.Item className={MENU_ITEM} onClick={() => { onOpen('registro'); }}>Cambiar ajustes</Menu.Item>
            <Menu.Item className={MENU_ITEM} onClick={() => { onOpen('operacion'); }}>Cambiar ejecución</Menu.Item>
            {view.hasRuntime ? <Menu.Item className={MENU_ITEM} disabled={Boolean(retiringBlock)} title={retiringBlock}
              onClick={() => { onOpen('operacion', 'retire'); }}>Retirar agente</Menu.Item> : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>}
  </li>;
}

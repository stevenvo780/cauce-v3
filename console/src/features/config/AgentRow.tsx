import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Monitor, Pencil, Rocket, Trash2 } from 'lucide-react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { AgentOrb } from '../../components/AgentOrb';
import { Button, MENU_ITEM, MENU_POPUP, Pill } from '../../components/kit';
import { onNavClick } from '../../router';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentWriteBlock } from './agent-registry-create';
import { agentView, type SheetTab } from './agent-view';
import { GroupChips } from './AgentSheetTabs';
import type { SettingsAgent } from './settings-model';

const KEBAB = 'absolute top-2 right-2 grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-fg data-[popup-open]:bg-muted-bg data-[popup-open]:text-fg';

/** One clean tile per agent: the whole tile opens its sheet; the kebab only jumps to a tab. */
export function AgentRow({ agent, snapshot, hosts, writeBlock, retireBlock, onOpen }: {
  agent: SettingsAgent;
  /** Why writing is not allowed for this account (RBAC), or undefined when it is. */
  writeBlock?: string | undefined;
  /** Why the fleet executor cannot retire agents, or undefined when it can (or is not known yet). */
  retireBlock?: string | undefined;
  snapshot: ConfigurationSnapshot;
  hosts: FleetHost[] | undefined;
  onOpen: (tab?: SheetTab, kind?: 'retire') => void;
}) {
  const view = agentView(agent, snapshot, hosts);
  const href = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}?view=context`;
  const deleteBlock = agentWriteBlock(snapshot, 'delete');
  const memberOnly = !agent.registered;
  const editBlock = writeBlock ?? agentWriteBlock(snapshot, 'update');
  const removeBlock = writeBlock ?? deleteBlock;
  const retiringBlock = writeBlock ?? retireBlock;
  const prepareBlock = writeBlock ?? agentWriteBlock(snapshot, 'update');
  return <li className={`relative min-w-0 rounded-xl border border-line bg-surface shadow-card transition-colors hover:border-line-strong hover:bg-subtle ${memberOnly ? 'opacity-70' : ''}`}>
    <button type="button" data-agent-tile={view.ref} onClick={() => { onOpen(); }} aria-label={`Abrir agente ${view.ref}`}
      className="grid w-full min-w-0 cursor-pointer gap-3 rounded-xl border-0 bg-transparent p-3.5 pr-11 pb-3 text-left text-fg outline-none focus-visible:outline-2 focus-visible:outline-brand">
      <span className="flex min-w-0 items-center gap-3">
        <AgentOrb seed={view.ref} size={36} />
        <span className="grid min-w-0 flex-1">
          <strong className="truncate text-sm" title={agent.name}>{agent.name}</strong>
          <span className="truncate font-mono text-xs text-muted" title={view.ref}>{agent.tenantId} / {agent.alias}</span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {memberOnly ? null : <Pill tone="neutral" className="max-w-full truncate">{agent.harness ?? 'arnés desconocido'}</Pill>}
        {memberOnly ? null : <Pill tone="neutral" className="max-w-full truncate" title="Computadora"><Monitor size={11} aria-hidden="true" />{view.hostName}</Pill>}
        <Pill tone={view.state.tone} className="max-w-full truncate">{view.state.label}</Pill>
      </span>
      <span className="flex min-h-5 flex-wrap items-center gap-1">
        <GroupChips agent={agent} max={3} />
      </span>
    </button>
    {memberOnly ? null : <div role="group" aria-label={`Acciones visibles de ${view.ref}`}
      className="flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 py-2.5">
        <Button size="sm" disabled={Boolean(editBlock)} title={editBlock ?? 'Editar el registro del agente'}
          aria-label={`Editar agente ${view.ref}`} onClick={() => { onOpen('registro'); }}>
          <Pencil size={12} aria-hidden="true" />Editar</Button>
        <Button size="sm" disabled={Boolean(prepareBlock)} title={prepareBlock ?? 'Preparar o actualizar la ejecución del agente'}
          aria-label={`Preparar agente ${view.ref}`} onClick={() => { onOpen('operacion'); }}>
          <Rocket size={12} aria-hidden="true" />Preparar</Button>
        {view.hasRuntime
          ? <Button size="sm" variant="danger" disabled={Boolean(retiringBlock)} title={retiringBlock ?? 'Detiene la ejecución y conserva el historial; la purga es el segundo paso'}
            aria-label={`Retirar agente ${view.ref}`} onClick={() => { onOpen('operacion', 'retire'); }}>
            <Trash2 size={12} aria-hidden="true" />Retirar</Button>
          : <Button size="sm" variant="danger" disabled={Boolean(removeBlock)} title={removeBlock ?? 'Sin ejecución que retirar: se elimina el registro desde su pestaña Registro'}
            aria-label={`Eliminar agente ${view.ref}`} onClick={() => { onOpen('registro'); }}>
            <Trash2 size={12} aria-hidden="true" />Eliminar</Button>}
    </div>}
    {memberOnly ? null : <Menu.Root>
      <Menu.Trigger aria-label={`Acciones de ${view.ref}`} title={`Acciones de ${view.ref}`} className={KEBAB}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-[60]">
          <Menu.Popup className={`${MENU_POPUP} w-56`}>
            <Menu.LinkItem href={href} closeOnClick className={MENU_ITEM} aria-label={`Perfil y contexto de ${view.ref}`}
              onClick={(event) => { onNavClick(event, href); }}>Perfil y contexto</Menu.LinkItem>
            <Menu.Item className={MENU_ITEM} onClick={() => { onOpen('registro'); }}>Editar registro</Menu.Item>
            <Menu.Item className={MENU_ITEM} onClick={() => { onOpen('operacion'); }}>Operar agente</Menu.Item>
            {view.hasRuntime ? <Menu.Item className={MENU_ITEM} disabled={Boolean(retiringBlock)} title={retiringBlock}
              onClick={() => { onOpen('operacion', 'retire'); }}>Retirar agente</Menu.Item> : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>}
  </li>;
}

import { Menu } from '@base-ui/react/menu';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { AgentOrb } from '../../components/AgentOrb';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { MENU_ITEM, MENU_POPUP, Pill } from '../../components/kit';
import { onNavClick } from '../../router';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentHostIdOf, agentHostRow, agentWriteBlock } from './agent-registry-create';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { AgentRegistryEditor } from './AgentRegistryEditor';
import { insigniaDeComputadora } from './fleet-host-model';
import type { SettingsAgent } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';
import { hostById } from './use-fleet-hosts';

const CHIP = 'max-w-full truncate rounded-full bg-muted-bg px-2 py-0.5 text-xs text-fg-2';
const KEBAB = 'relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-fg data-[popup-open]:bg-muted-bg data-[popup-open]:text-fg';

interface Lifecycle { action?: 'retire' }

/** One compact card per agent: identity, state chips and every action behind one menu. */
export function AgentRow({ agent, snapshot, hosts, onReloaded, onDeleted, hidden }: {
  agent: SettingsAgent;
  hidden: boolean;
  snapshot: ConfigurationSnapshot;
  hosts: FleetHost[] | undefined;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDeleted: (notice: ConfigMutationNotice) => void;
}) {
  const [registryOpen, setRegistryOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<Lifecycle>();
  const ref = `${agent.tenantId}/${agent.alias}`;
  const href = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}?view=context`;
  const row = agentHostRow(snapshot, agent.tenantId, agent.alias);
  const hostId = agentHostIdOf(row);
  const host = hostById(hosts, hostId);
  const badge = insigniaDeComputadora(host);
  const hasRuntime = row?.runtime_key !== undefined && row.runtime_key !== null;
  const deleteBlock = agentWriteBlock(snapshot, 'delete');
  const closeRegistry = () => { setRegistryOpen(false); };
  const closeLifecycle = () => { setLifecycle(undefined); };
  return <li hidden={hidden} inert={hidden} className="grid min-w-0 gap-2.5 rounded-xl border border-line bg-surface p-3 shadow-card">
    <div className="flex items-start gap-3">
      <AgentOrb seed={ref} size={32} />
      <div className="min-w-0 flex-1">
        <p className="m-0 flex min-w-0 items-baseline gap-x-2">
          <strong className="min-w-0 truncate text-sm" title={agent.name}>{agent.name}</strong>
          <span className="min-w-0 truncate font-mono text-xs text-muted" title={ref}>{agent.tenantId} / {agent.alias}</span>
        </p>
        <p className="m-0 mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className={CHIP}>Arnés declarado: {agent.harness ?? 'desconocido'}</span>
          {agent.registered ? <span className={CHIP}>Computadora: {host?.display_name ?? hostId ?? 'sin asignar'}</span> : null}
          {agent.enabled === false ? <Pill tone="warn">Registro deshabilitado</Pill> : null}
          {badge ? <Pill tone="warn">{badge}</Pill> : null}
          {agent.registered ? null : <span className={CHIP} title="Solo aparece como miembro de un grupo, sin registro editable de agente.">Solo miembro</span>}
        </p>
      </div>
      {agent.registered ? <Menu.Root>
        <Menu.Trigger aria-label={`Acciones de ${ref}`} title={`Acciones de ${ref}`} className={KEBAB}>
          <Ellipsis size={16} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50">
            <Menu.Popup className={`${MENU_POPUP} w-56`}>
              <Menu.LinkItem href={href} closeOnClick className={MENU_ITEM} aria-label={`Perfil y contexto de ${ref}`}
                onClick={(event) => { onNavClick(event, href); }}>Perfil y contexto</Menu.LinkItem>
              <Menu.Item className={MENU_ITEM} onClick={() => { setRegistryOpen(true); }}>Editar registro</Menu.Item>
              <Menu.Item className={MENU_ITEM} onClick={() => { setLifecycle((prev) => prev ?? {}); }}>Operar agente</Menu.Item>
              {hasRuntime ? <Menu.Item className={MENU_ITEM} disabled={Boolean(deleteBlock)} title={deleteBlock}
                onClick={() => { setLifecycle({ action: 'retire' }); }}>Retirar agente</Menu.Item> : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root> : null}
    </div>
    {agent.registered ? <p className={`m-0 line-clamp-2 text-[13px] ${agent.responsibility ? 'text-fg-2' : 'text-muted italic'}`}>
      {agent.responsibility ?? 'Responsabilidad sin publicar en esta lectura'}
    </p> : null}
    <div className="flex flex-wrap items-start gap-1.5" aria-label={`Grupos de ${ref}`}>
      {!agent.groupsKnown ? <span className={CHIP}>Grupos desconocidos</span>
        : !agent.groups.length ? <span className={CHIP}>Sin membresías registradas</span>
          : agent.groups.map((group) => <span key={group.id} title={group.id} className={CHIP}>
            {group.label}{group.enabled === false ? ' · membresía deshabilitada'
              : group.enabled === undefined ? ' · estado desconocido' : ''}
          </span>)}
    </div>
    {registryOpen ? <ErrorBoundary label={`Registro de ${ref}`} onReset={closeRegistry}>
      <AgentRegistryEditor snapshot={snapshot} hosts={hosts} onReloaded={onReloaded} tenantId={agent.tenantId}
        alias={agent.alias} onDeleted={onDeleted} initialOpen hideTrigger onClose={closeRegistry} />
    </ErrorBoundary> : null}
    {lifecycle ? <ErrorBoundary label={`Operación de ${ref}`} onReset={closeLifecycle}>
      <AgentLifecyclePanel key={lifecycle.action ?? 'operate'} snapshot={snapshot} onReloaded={onReloaded} initialOpen hideTrigger
        initialKind={lifecycle.action} onClose={closeLifecycle} target={{ resource: 'agent', tenant_id: agent.tenantId, alias: agent.alias }} />
    </ErrorBoundary> : null}
  </li>;
}

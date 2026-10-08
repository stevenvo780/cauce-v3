import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { AgentOrb } from '../../components/AgentOrb';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Button, Notice, Pill } from '../../components/kit';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentView, type SheetTab } from './agent-view';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { AgentRegistryEditor } from './AgentRegistryEditor';
import { GroupsTab, SummaryTab } from './AgentSheetTabs';
import { CloseButton, DIALOG_BODY, DRAWER_POPUP } from './config-dialog';
import type { SettingsAgent } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';

const TAB = 'cursor-pointer whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-3 py-2.5 text-[13px] font-medium text-muted outline-none '
  + 'transition-colors hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand data-[active]:border-brand data-[active]:text-fg';
const TAB_LABEL: Record<SheetTab, string> = { resumen: 'Resumen', registro: 'Registro', operacion: 'Operación', grupos: 'Grupos' };

export interface SheetIntent { tab: SheetTab; kind?: 'retire' }

/**
 * The one place an agent is read and edited: a right-side drawer (full screen on phones). Every tab
 * stays mounted once visited, so an unsaved registry draft survives a tab switch; closing with one
 * asks first, inside the sheet.
 */
export function AgentSheet({ agent, retired = false, snapshot, hosts, intent, finalFocus, onReloaded, onDeleted, onClose }: {
  agent: SettingsAgent;
  retired?: boolean;
  snapshot: ConfigurationSnapshot;
  hosts: FleetHost[] | undefined;
  intent: SheetIntent;
  finalFocus: ComponentProps<typeof Dialog.Popup>['finalFocus'];
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDeleted: (notice: ConfigMutationNotice) => void;
  onClose: () => void;
}) {
  const view = agentView(agent, snapshot, hosts);
  const editable = agent.registered && !retired;
  const tabs: SheetTab[] = editable ? ['resumen', 'registro', 'operacion', 'grupos'] : ['resumen', 'grupos'];
  const [tab, setTab] = useState<SheetTab>(tabs.includes(intent.tab) ? intent.tab : 'resumen');
  const [visited, setVisited] = useState<ReadonlySet<SheetTab>>(() => new Set([tab]));
  const [dirtySources, setDirtySources] = useState<ReadonlySet<SheetTab>>(new Set());
  const dirty = dirtySources.size > 0;
  const [confirming, setConfirming] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const target = { resource: 'agent' as const, tenant_id: agent.tenantId, alias: agent.alias };

  useEffect(() => { if (confirming) keepEditing.current?.focus(); }, [confirming]);

  const markers = useMemo(() => Object.fromEntries((['registro', 'operacion', 'grupos'] as const).map((id) => [id, (value: boolean) => {
    setDirtySources((previous) => {
      if (previous.has(id) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }])) as Record<'registro' | 'operacion' | 'grupos', (value: boolean) => void>, []);

  function requestClose() {
    if (dirty) setConfirming(true); else onClose();
  }
  function select(next: SheetTab) {
    setTab(next);
    setVisited((previous) => new Set(previous).add(next));
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) requestClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <Dialog.Popup className={DRAWER_POPUP} finalFocus={finalFocus}>
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <AgentOrb seed={view.ref} size={40} />
          <div className="min-w-0 flex-1">
            <Dialog.Title className="m-0 truncate text-base font-semibold" title={agent.name}>{agent.name}</Dialog.Title>
            <Dialog.Description className="m-0 truncate font-mono text-xs text-muted" title={view.ref}>
              {agent.tenantId} / {agent.alias}
            </Dialog.Description>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {retired ? <Pill tone="neutral">Retirado</Pill> : <>
                <Pill tone={view.state.tone}>{view.state.label}</Pill>
                {agent.harness ? <Pill tone="info">{agent.harness}</Pill> : null}
                {agent.registered ? <Pill tone="neutral">{view.hostName}</Pill> : null}
              </>}
            </div>
          </div>
          <CloseButton />
        </header>
        {confirming ? <div className="shrink-0 border-b border-line px-5 py-3">
          <Notice tone="warn" role="alert" className="grid gap-2">
            <p><strong>Tenés cambios sin guardar.</strong> Si cerrás ahora, se descartan los borradores sin confirmar.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" ref={keepEditing} onClick={() => { setConfirming(false); }}>Seguir editando</Button>
              <Button size="sm" variant="danger" onClick={onClose}>Descartar y cerrar</Button>
            </div>
          </Notice>
        </div> : null}
        {retired ? <div className={DIALOG_BODY}>
          <ErrorBoundary label={`Operación de ${view.ref}`} onReset={onClose}>
            <AgentLifecyclePanel snapshot={snapshot} onReloaded={onReloaded} initialOpen hideTrigger embedded target={target} />
          </ErrorBoundary>
        </div> : <Tabs.Root value={tab} onValueChange={(value) => { select(value as SheetTab); }} className="flex min-h-0 flex-1 flex-col">
          {tabs.length > 1 ? <Tabs.List aria-label={`Secciones de ${view.ref}`} activateOnFocus
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3">
            {tabs.map((id) => <Tabs.Tab key={id} value={id} className={TAB}>{TAB_LABEL[id]}</Tabs.Tab>)}
          </Tabs.List> : null}
          {tabs.map((id) => <Tabs.Panel key={id} value={id} keepMounted className={`${DIALOG_BODY} outline-none`}>
            {!visited.has(id) ? null : id === 'resumen' ? <SummaryTab agent={agent} view={view} snapshot={snapshot} />
              : id === 'grupos' ? <GroupsTab agent={agent} view={view} snapshot={snapshot} onReloaded={onReloaded} onDirtyChange={markers.grupos} />
                : id === 'registro' ? <ErrorBoundary label={`Registro de ${view.ref}`} onReset={() => { select('resumen'); }}>
                  <AgentRegistryEditor snapshot={snapshot} hosts={hosts} onReloaded={onReloaded} tenantId={agent.tenantId}
                    alias={agent.alias} onDeleted={onDeleted} initialOpen hideTrigger embedded onDirtyChange={markers.registro} />
                </ErrorBoundary>
                  : <ErrorBoundary label={`Operación de ${view.ref}`} onReset={() => { select('resumen'); }}>
                    <AgentLifecyclePanel snapshot={snapshot} onReloaded={onReloaded} initialOpen hideTrigger embedded target={target}
                      initialKind={intent.kind} onDirtyChange={markers.operacion} />
                  </ErrorBoundary>}
          </Tabs.Panel>)}
        </Tabs.Root>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

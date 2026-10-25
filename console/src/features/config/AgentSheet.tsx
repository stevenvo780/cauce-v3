import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { AgentOrb } from '../../components/AgentOrb';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Button, Notice, Pill } from '../../components/kit';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentQuotaDetail } from '../accounts/AgentQuotaDetail';
import { agentView, respondsAnswer, SHEET_TAB_LABEL, subtituloDeAgente, type SheetTab } from './agent-view';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { AgentDangerZone, AgentQuickActions } from './AgentQuickActions';
import { AgentRegistryEditor } from './AgentRegistryEditor';
import { AgentRemovalDialog } from './AgentRemovalDialog';
import { GroupsTab, SummaryTab } from './AgentSheetTabs';
import { useLiveAgent } from './use-live-agent';
import { AmpliacionesTab } from './AmpliacionesTab';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { BLOCK_TITLE } from './config-ui';
import { teamBlock } from './team-access';
import { TeamFormDialog } from './TeamFormDialog';
import type { ConfigWrites } from './use-config-writes';
import { CloseButton, DIALOG_BODY, DRAWER_POPUP } from './config-dialog';
import type { SettingsAgent } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';

const TAB = 'min-h-8 cursor-pointer whitespace-nowrap rounded-md border-0 bg-transparent px-2.5 text-[13px] sm:px-3 font-medium text-muted outline-none '
  + 'transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand data-[active]:bg-brand-soft data-[active]:text-fg';

type OperationKind = 'retire' | 'purge' | 'start' | 'stop';
export interface SheetIntent { tab: SheetTab; kind?: OperationKind; remove?: boolean }

/**
 * The one place an agent is read and edited: a right-side drawer (full screen on phones). «Estado» answers
 * the everyday questions and holds the frequent actions; the other tabs are for changing things. Every tab
 * stays mounted once visited, so an unsaved draft survives a tab switch; closing with one asks first.
 */
export function AgentSheet({ agent, retired = false, snapshot, hosts, intent, finalFocus, ctx, onReloaded, onDeleted, onClose: close }: {
  agent: SettingsAgent;
  retired?: boolean;
  snapshot: ConfigurationSnapshot;
  hosts: FleetHost[] | undefined;
  intent: SheetIntent;
  /** The shared write channels: with them, the «Grupos» tab can open a team's editor. */
  ctx?: ConfigWrites | undefined;
  finalFocus: ComponentProps<typeof Dialog.Popup>['finalFocus'];
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDeleted: (notice: ConfigMutationNotice) => void;
  onClose: () => void;
}) {
  const view = agentView(agent, snapshot, hosts);
  const live = useLiveAgent(agent.tenantId, agent.alias);
  const responds = respondsAnswer(live?.state);
  const editable = agent.registered && !retired;
  const tabs: SheetTab[] = editable ? ['resumen', 'registro', 'operacion', 'ampliaciones', 'grupos'] : ['resumen', 'grupos'];
  const [tab, setTab] = useState<SheetTab>(tabs.includes(intent.tab) ? intent.tab : 'resumen');
  const [visited, setVisited] = useState<ReadonlySet<SheetTab>>(() => new Set([tab]));
  const [dirtySources, setDirtySources] = useState<ReadonlySet<SheetTab>>(new Set());
  const dirty = dirtySources.size > 0;
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(Boolean(intent.remove) && agent.registered);
  const [removedSnapshot, setRemovedSnapshot] = useState<ConfigurationSnapshot>();
  const [operation, setOperation] = useState<{ kind: OperationKind | undefined; mount: number }>({ kind: intent.kind, mount: 0 });
  const keepEditing = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const target = { resource: 'agent' as const, tenant_id: agent.tenantId, alias: agent.alias };

  function retainOperationResult(next: ConfigurationSnapshot) {
    const present = [...(next.agents ?? []), ...(next.retired?.agents ?? [])]
      .some((row) => row.tenant_id === agent.tenantId && row.alias === agent.alias);
    if (Array.isArray(next.agents) && !present) setRemovedSnapshot(next);
    else { setRemovedSnapshot(undefined); onReloaded(next); }
  }
  function onClose() {
    if (removedSnapshot) onReloaded(removedSnapshot);
    close();
  }

  useEffect(() => { if (confirming) keepEditing.current?.focus(); }, [confirming]);

  const markers = useMemo(() => Object.fromEntries((['registro', 'operacion', 'grupos', 'ampliaciones'] as const).map((id) => [id, (value: boolean) => {
    setDirtySources((previous) => {
      if (previous.has(id) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }])) as Record<'registro' | 'operacion' | 'grupos' | 'ampliaciones', (value: boolean) => void>, []);

  function requestClose() {
    if (dirty) setConfirming(true); else onClose();
  }
  function select(next: SheetTab) {
    setTab(next);
    setVisited((previous) => new Set(previous).add(next));
  }
  function power(kind: 'start' | 'stop') {
    if (!dirtySources.has('operacion')) setOperation((previous) => ({ kind, mount: previous.mount + 1 }));
    select('operacion');
  }
  function remove() {
    if (retired || view.hasRuntime) setRemoving(true); else select('registro');
  }
  const danger = agent.registered
    ? <AgentDangerZone refLabel={view.ref} retired={retired} hasRuntime={view.hasRuntime} onRemove={remove} /> : null;

  // Only a deliberate gesture closes the sheet: Escape, its close button, or a press that really lands on the backdrop.
  // A press whose target is gone from the DOM (a re-render replaced the pressed button) or sits inside the sheet,
  // and focus moving around, are not requests to close it.
  function onOpenChange(open: boolean, details: Dialog.Root.ChangeEventDetails) {
    if (open) return;
    const target = details.event.target;
    const stray = details.reason === 'focus-out'
      || (details.reason === 'outside-press' && target instanceof Node && (!target.isConnected || Boolean(popup.current?.contains(target))));
    if (stray) { details.cancel(); return; }
    requestClose();
  }

  return <Dialog.Root open onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <Dialog.Popup ref={popup} className={DRAWER_POPUP} finalFocus={finalFocus}>
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <AgentOrb seed={view.ref} size={44} />
          <div className="grid min-w-0 flex-1 gap-1">
            <Dialog.Title className="m-0 truncate text-base font-semibold" title={agent.name}>{agent.name}</Dialog.Title>
            <Dialog.Description className="m-0 truncate text-xs text-muted" title={view.ref}>
              {subtituloDeAgente(agent, snapshot)}
            </Dialog.Description>
            <span className="flex flex-wrap items-center gap-1.5">
              {retired ? <Pill tone="neutral">Retirado</Pill> : <>
                {agent.registered ? <Pill tone={responds.tone} title={live?.reason ?? responds.detail}>{responds.label}</Pill> : null}
                {!agent.registered || view.state.tone !== 'ok' ? <Pill tone={view.state.tone}>{view.state.label}</Pill> : null}
              </>}
            </span>
          </div>
          <CloseButton />
        </header>
        {confirming ? <div className="shrink-0 border-b border-line px-5 py-3">
          <Notice tone="warn" role="alert" className="grid gap-2">
            <p><strong>Tienes cambios sin guardar.</strong> Si cierras ahora, se descartan los borradores sin confirmar.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" ref={keepEditing} onClick={() => { setConfirming(false); }}>Seguir editando</Button>
              <Button size="sm" variant="danger" onClick={onClose}>Descartar y cerrar</Button>
            </div>
          </Notice>
        </div> : null}
        {retired ? <div className={`${DIALOG_BODY} grid content-start gap-6`}>
          <Notice role="note">Este agente está retirado: no recibe mensajes y su historial se conserva. Puedes restaurarlo o eliminarlo definitivamente.</Notice>
          <ErrorBoundary label={`Operación de ${view.ref}`} onReset={onClose}>
            <AgentLifecyclePanel snapshot={snapshot} onReloaded={retainOperationResult} initialOpen hideTrigger embedded target={target}
              initialKind={intent.kind} />
          </ErrorBoundary>
          {danger}
        </div> : <Tabs.Root value={tab} onValueChange={(value) => { select(value as SheetTab); }} className="flex min-h-0 flex-1 flex-col">
          {tabs.length > 1 ? <Tabs.List aria-label={`Secciones de ${view.ref}`} activateOnFocus
            className="flex shrink-0 flex-wrap gap-1 border-b border-line px-3 py-2 sm:px-5">
            {tabs.map((id) => <Tabs.Tab key={id} value={id} className={TAB}>{SHEET_TAB_LABEL[id]}</Tabs.Tab>)}
          </Tabs.List> : null}
          {tabs.map((id) => <Tabs.Panel key={id} value={id} keepMounted className={`${DIALOG_BODY} outline-none`}>
            {!visited.has(id) ? null : id === 'resumen' ? <SummaryTab agent={agent} view={view} snapshot={snapshot} danger={editable ? danger : null}
              actions={editable ? <AgentQuickActions agent={agent} hasRuntime={view.hasRuntime} hasComputer={Boolean(view.hostId)} onPower={power}
                onPrepare={() => { select('operacion'); }} /> : null}
              quota={editable ? <section className="grid gap-3" aria-label={`Cuota de la cuenta de ${view.ref}`}>
                <h3 className={BLOCK_TITLE}>Cuota de su cuenta</h3>
                <ErrorBoundary label={`Cuota de ${view.ref}`}><AgentQuotaDetail tenant={agent.tenantId} alias={agent.alias} /></ErrorBoundary>
              </section> : null} />
              : id === 'grupos' ? <GroupsTab agent={agent} view={view} snapshot={snapshot} onReloaded={onReloaded} onDirtyChange={markers.grupos}
                onEditTeam={ctx ? (row) => { ctx.openForm({ collection: 'rooms', action: 'update', row }, true); } : undefined}
                editBlock={ctx ? (row) => teamBlock(ctx, 'update', row) : undefined} />
                : id === 'ampliaciones' ? <ErrorBoundary label={`Ampliaciones de ${view.ref}`} onReset={() => { select('resumen'); }}>
                  <ConsoleAccessBoundary><AmpliacionesTab tenantId={agent.tenantId} alias={agent.alias} snapshot={snapshot} hostId={view.hostId}
                    hostRaw={hosts?.find((host) => host.host_id === view.hostId)}
                    onReloaded={onReloaded} onDirtyChange={markers.ampliaciones} /></ConsoleAccessBoundary>
                </ErrorBoundary>
                : id === 'registro' ? <ErrorBoundary label={`Registro de ${view.ref}`} onReset={() => { select('resumen'); }}>
                  <AgentRegistryEditor snapshot={snapshot} hosts={hosts} onReloaded={onReloaded} tenantId={agent.tenantId}
                    alias={agent.alias} onDeleted={onDeleted} onDirtyChange={markers.registro} />
                </ErrorBoundary>
                  : <ErrorBoundary label={`Operación de ${view.ref}`} onReset={() => { select('resumen'); }}>
                    <AgentLifecyclePanel key={operation.mount} snapshot={snapshot} onReloaded={retainOperationResult} initialOpen hideTrigger embedded target={target}
                      initialKind={operation.kind} onDirtyChange={markers.operacion} />
                  </ErrorBoundary>}
          </Tabs.Panel>)}
        </Tabs.Root>}
        {ctx ? <TeamFormDialog ctx={ctx} /> : null}
        {removing ? <AgentRemovalDialog tenantId={agent.tenantId} alias={agent.alias} retired={retired} snapshot={snapshot}
          onReloaded={retainOperationResult} onClose={() => { setRemoving(false); if (removedSnapshot) onClose(); }} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

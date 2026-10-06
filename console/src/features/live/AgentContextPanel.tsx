import { Tabs } from '@base-ui/react/tabs';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import type { AgentPerfilCampos, ConfigurationSnapshot } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';
import { Button, Notice } from '../../components/form-kit';
import { permissionState } from '../../lib';
import { ContextRepositoryPanel } from './ContextRepositoryPanel';
import { DirectivaPanel } from './DirectivaPanel';
import { FicherosTab } from './FicherosTab';
import { HistorialDeContexto } from './HistorialDeContexto';
import { PerfilTab } from './PerfilTab';
import { TabStrip } from './context-ui';
import { useContextEditorStore } from './context-editor-store';

type Section = 'perfil' | 'ficheros' | 'directiva' | 'historial' | 'git';
export type ContextSection = Section;

interface PanelProps {
  tenantId: string;
  alias: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** Section to open first. */
  initialSection?: Section;
  configuration?: Resource<ConfigurationSnapshot>;
}

/**
 * The one place to read and edit an agent's profile, manual, files, directive, Git versions and
 * history. Canonical fields and the site manual keep their separate write contracts and receipts:
 * living on one page does not pretend that one write applies the other.
 */
export function AgentContextPanel(props: PanelProps) {
  return <ConsoleAccessBoundary>{props.configuration
    ? <ContextPanelContent {...props} configuration={props.configuration} />
    : <LoadContextPanel {...props} />}</ConsoleAccessBoundary>;
}

function LoadContextPanel(props: PanelProps) {
  const api = useApi();
  const configuration = useResource('context-configuration', () => api.getConfiguration());
  return <ContextPanelContent {...props} configuration={configuration} />;
}

function ContextPanelContent({ tenantId, alias, onDirtyChange, initialSection = 'perfil', configuration }: PanelProps & {
  configuration: Resource<ConfigurationSnapshot>;
}) {
  const access = useConsoleAccess();
  const configWritePermission = permissionState(access.error ? undefined : access.data, 'config.write');
  const { identity, state, update, settle, documentDraft, refresh } = useContextEditorStore(tenantId, alias);
  const [section, setSection] = useState<Section>(initialSection);
  const [manualApplied, setManualApplied] = useState<string>();
  const [restores, setRestores] = useState(0);
  const targets = useRef<Partial<Record<Section, HTMLDivElement | null>>>({});
  const profileDraft = state.profile !== undefined;
  const manualDraft = state.files.directive !== undefined;
  const dirty = profileDraft || Object.keys(state.files).length > 0;
  useEffect(() => { onDirtyChange?.(dirty || state.busy); }, [dirty, state.busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !state.busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [dirty, state.busy]);

  const go = useCallback((next: Section) => {
    setSection(next);
    // The button that asked for the move unmounts with its tab: focus follows to the new one.
    requestAnimationFrame(() => { targets.current[next]?.focus({ preventScroll: true }); });
  }, []);
  const refreshReaders = useCallback(() => {
    refresh();
    void configuration.reload();
  }, [configuration, refresh]);
  const onWriteInFlight = useCallback((busy: boolean) => {
    if (busy) setManualApplied(undefined);
    update({ busy });
  }, [update]);
  useEffect(() => {
    if (state.files.directive !== undefined) setManualApplied(undefined);
  }, [state.files.directive]);
  const restoreProfile = (fields: AgentPerfilCampos) => {
    if (state.busy) return;
    // A restore replays the SEVEN authored fields, the unit the profile is saved in, and writes
    // nothing: the manual draft stays as the operator left it.
    update({ profile: fields, outcome: undefined });
    setRestores((n) => n + 1);
    go('perfil');
  };
  const target = (key: Section) => (node: HTMLDivElement | null) => { targets.current[key] = node; };
  const panel = 'mt-4 outline-none';
  const dot = (label: string) => <span role="img" aria-label={label} className="size-1.5 rounded-full bg-warn" />;

  return (
    <Tabs.Root key={identity} value={section} onValueChange={(value) => { setSection(value as Section); }} className="grid grid-cols-[minmax(0,1fr)]">
      <div className="sticky top-0 z-20 -mx-4 flex items-end justify-between gap-2 bg-canvas px-4 sm:-mx-6 sm:px-6">
        <TabStrip label="Secciones del contexto" className="min-w-0 flex-1" tabs={[
          { id: 'perfil', label: <>Perfil{profileDraft ? dot('borrador sin guardar') : null}</> },
          { id: 'ficheros', label: <>Ficheros{manualDraft ? dot('borrador sin guardar') : null}</> },
          { id: 'directiva', label: 'Directiva' },
          { id: 'historial', label: 'Historial' },
          { id: 'git', label: 'Git' },
        ]} />
        <Button variant="ghost" size="sm" className="mb-1.5" disabled={state.busy} onClick={refresh}
          aria-label="Actualizar estado del contexto" title="Actualizar estado del contexto">
          <RefreshCw size={14} aria-hidden="true" /><span className="max-sm:sr-only">Actualizar</span>
        </Button>
      </div>
      {dirty ? <Notice tone="warn" role="status" className="mt-4">
        Borrador sin guardar. Cerrar este panel lo conserva en esta pestaña; recargar la página lo pierde.
      </Notice> : null}

      <Tabs.Panel value="perfil" keepMounted className={panel}>
        <div ref={target('perfil')} tabIndex={-1} className="outline-none">
          <PerfilTab
            tenantId={tenantId} alias={alias}
            borrador={state.profile}
            onBorrador={(profile) => { update({ profile, outcome: undefined }); }}
            onMutationSettled={refreshReaders}
            onWriteInFlightChange={onWriteInFlight}
            writeInFlight={state.busy}
            blockedByManualDraft={manualDraft}
            runtimeRefreshRevision={state.revision}
            restauracion={restores}
            configWritePermission={configWritePermission}
            outcome={state.outcome}
            onSettlement={settle}
          />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="ficheros" keepMounted className={panel}>
        <div ref={target('ficheros')} tabIndex={-1} className="grid gap-3 outline-none">
          {manualApplied ? <Notice tone="ok" role="status">{manualApplied}</Notice> : null}
          <FicherosTab
            key={String(state.revision)}
            tenantId={tenantId} alias={alias}
            borradores={state.files}
            onBorrador={documentDraft}
            onApplied={(message) => { setManualApplied(message); refreshReaders(); }}
            mutationBlocked={state.busy}
            configWritePermission={configWritePermission}
          />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="directiva" className={panel}>
        <div ref={target('directiva')} tabIndex={-1} className="outline-none">
          <DirectivaPanel
            key={state.revision}
            tenantId={tenantId} alias={alias} configuration={configuration}
            onEditProfile={() => { go('perfil'); }}
            onEditManual={() => { go('ficheros'); }}
          />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="historial" className={panel}>
        <div ref={target('historial')} tabIndex={-1} className="outline-none">
          <HistorialDeContexto tenantId={tenantId} alias={alias}
            onRestaurar={configWritePermission === 'allowed' && !state.busy ? restoreProfile : undefined} />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="git" className={panel}>
        <div ref={target('git')} tabIndex={-1} className="outline-none">
          <ContextRepositoryPanel
            tenantId={tenantId} alias={alias}
            canApply={configWritePermission === 'allowed'}
            blocked={state.busy || profileDraft || manualDraft}
            refreshRevision={state.revision} onSettled={refreshReaders}
            onWriteInFlightChange={onWriteInFlight}
          />
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

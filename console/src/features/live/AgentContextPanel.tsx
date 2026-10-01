import { useEffect } from 'react';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';
import { ContextoTab } from './ContextoTab';
import { FicherosTab } from './FicherosTab';
import { useContextEditorStore } from './context-editor-store';
import './live.css';

interface PanelProps {
  tenantId: string;
  alias: string;
  onDirtyChange?: (dirty: boolean) => void;
  focusTarget?: 'campos' | 'manual';
  configuration?: Resource<ConfigurationSnapshot>;
}

/** The chat and fleet entry points reuse the same authoring contracts. */
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

function ContextPanelContent({ tenantId, alias, onDirtyChange, focusTarget, configuration }: PanelProps & {
  configuration: Resource<ConfigurationSnapshot>;
}) {
  const { identity, state, update, settle, documentDraft, refresh } = useContextEditorStore(tenantId, alias);
  const dirty = state.profile !== undefined || Object.keys(state.files).length > 0;
  useEffect(() => { onDirtyChange?.(dirty || state.busy); }, [dirty, state.busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !state.busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [dirty, state.busy]);
  return (
    <div className="agent-context-panel">
      <p className="context-panel-scope">{tenantId} / {alias} · Configuración del agente</p>
      <button type="button" className="button small secondary" disabled={state.busy}
        onClick={refresh}>
        Actualizar estado del contexto
      </button>
      {dirty ? <p className="context-draft-notice" role="status">Borrador sin guardar. Cerrar este panel lo conserva en esta pestaña; recargar la página lo pierde.</p> : null}
      <ContextoTab
        key={identity}
        tenantId={tenantId} alias={alias} configuracion={configuration}
        focusTarget={focusTarget}
        borradorPerfil={state.profile} onBorradorPerfil={(profile) => { update({ profile, outcome: undefined }); }}
        profileOutcome={state.outcome}
        onProfileSettlement={settle}
        borradoresFicheros={state.files}
        onBorradorFichero={documentDraft}
        profileWriteInFlight={state.busy}
        onProfileWriteInFlightChange={(busy) => { update({ busy }); }}
        runtimeRefreshRevision={state.revision}
        onRuntimeRefresh={refresh}
      />
    </div>
  );
}

export function AgentDocumentsPanel(props: { tenantId: string; alias: string; onOpenContext: () => void }) {
  return <ConsoleAccessBoundary><DocumentsPanelContent {...props} /></ConsoleAccessBoundary>;
}

function DocumentsPanelContent({ tenantId, alias, onOpenContext }: { tenantId: string; alias: string; onOpenContext: () => void }) {
  const { state, documentDraft } = useContextEditorStore(tenantId, alias);
  return <FicherosTab key={`${tenantId}/${alias}/${String(state.revision)}`} tenantId={tenantId} alias={alias}
    borradores={state.files} onBorrador={documentDraft} mode="inventory" onOpenContext={onOpenContext} />;
}

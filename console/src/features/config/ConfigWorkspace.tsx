import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, RefreshButton } from '../../components/ui';
import { onNavClick } from '../../router';
import { AgentSettings } from './AgentSettings';
import { esNegativaDePermiso } from './config-change';
import './settings.css';

export function ConfigWorkspace({ administration }: { administration: (active: boolean) => ReactNode }) {
  const [advanced, setAdvanced] = useState(false);
  const [visited, setVisited] = useState(false);
  const advancedPanel = useRef<HTMLDivElement>(null);
  const overviewPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (advanced && document.activeElement?.closest('[role="dialog"]')) return;
    if (visited) (advanced ? advancedPanel : overviewPanel).current?.focus({ preventScroll: true });
  }, [advanced, visited]);
  return <>
    {!advanced ? <div ref={overviewPanel} tabIndex={-1}>
      <ConsoleAccessBoundary><ConfigOverview onAdvanced={() => { setVisited(true); setAdvanced(true); }} /></ConsoleAccessBoundary>
    </div> : null}
    {visited ? <div ref={advancedPanel} tabIndex={-1} hidden={!advanced} inert={!advanced}>
      <button type="button" className="button secondary settings-return" onClick={() => { setAdvanced(false); }}>
        Volver a agentes y contexto
      </button>
      {administration(advanced)}
    </div> : null}
  </>;
}

function ConfigOverview({ onAdvanced }: { onAdvanced: () => void }) {
  const api = useApi();
  const configuration = useResource('configuration-settings', () => api.getConfiguration());
  if (configuration.loading && !configuration.data) return <LoadingState label="Leyendo configuración…" />;
  if (configuration.error && !configuration.data) {
    return esNegativaDePermiso(configuration.error)
      ? <section className="state-card" role="note"><div>
        <h1>Configuración</h1><p>Esta vista necesita permiso de lectura de configuración.</p>
        <p>{configuration.error.message}</p>
        <a href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }}>Volver a conversaciones</a>
      </div></section>
      : <ErrorState error={configuration.error} onRetry={configuration.reload} />;
  }
  return <div className="settings-page">
    <PageHeader title="Ajustes y altas" eyebrow="Agentes y grupos"
      description="Elegí un agente para editar su contexto y comprobar qué aplica su arnés."
      actions={<RefreshButton onClick={configuration.reload} loading={configuration.loading} />}
    />
    {configuration.error ? <p className="notice error" role="alert">
      No se pudo actualizar: se muestra la última lectura válida ({configuration.error.message}).
    </p> : null}
    {configuration.data ? <AgentSettings snapshot={configuration.data} /> : null}
    <details className="settings-policy">
      <summary>Comunicación y permisos</summary>
      <p>Los grupos organizan identidad y responsabilidad. Los miembros habilitados de un mismo tenant
        pueden dirigirse mensajes si su rol permite publicar; no necesitan una ACL entre grupos.</p>
      <p>Esto no acredita acceso al historial, control ni credenciales. Los cruces entre tenants,
        permisos, límites y protecciones de cadena se comprueban por separado en el servidor.</p>
    </details>
    <div className="settings-administration">
      <div><h2>Administración</h2><p>Altas y grupos, acceso entre tenants, límites, avisos e historial de cambios.</p></div>
      <button type="button" className="button secondary" onClick={onAdvanced}>Administración avanzada</button>
      <a className="button secondary" href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Cuentas y cuotas</a>
    </div>
  </div>;
}

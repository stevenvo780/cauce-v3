import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LoadingState } from '../../components/ui';
import { onNavClick } from '../../router';

const AgentContextPanel = lazy(async () => ({
  default: (await import('../live/AgentContextPanel')).AgentContextPanel,
}));

export function AgentSettingsView({ tenantId, alias, conversationPath }: {
  tenantId: string; alias: string; conversationPath: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <section className="chat-settings-view" aria-label={`Configuración de ${alias}`}>
    <header className="chat-settings-head">
      <a className="button small secondary" href={conversationPath} onClick={(event) => { onNavClick(event, conversationPath); }}>
        <ArrowLeft size={16} aria-hidden="true" /> Volver a la conversación
      </a>
      <h2 ref={heading} tabIndex={-1}>Configuración de {alias}</h2>
      <p>Personalidad, instrucciones y contexto según su arnés</p>
    </header>
    <div className="chat-settings-body">
      <ErrorBoundary label={`Configuración de ${alias}`} resetKey={`${tenantId}:${alias}`}>
        <Suspense fallback={<LoadingState label="Abriendo la configuración del agente…" />}>
          <AgentContextPanel tenantId={tenantId} alias={alias} />
        </Suspense>
      </ErrorBoundary>
    </div>
  </section>;
}

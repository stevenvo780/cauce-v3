import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { AgentOrb } from '../../components/AgentOrb';
import { AgentContextMenu, AgentKebab } from '../../components/agent-actions/AgentActionsMenu';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LinkButton, StatePill } from '../../components/kit';
import { LoadingState } from '../../components/ui';
import { onNavClick, useRouteSearch } from '../../router';
import { useFleet } from '../../shell/fleet-context';
import { agentLiveState } from '../terminal/fleet';
import type { ContextSection } from '../live/AgentContextPanel';

const AgentContextPanel = lazy(async () => ({
  default: (await import('../live/AgentContextPanel')).AgentContextPanel,
}));

const SECTIONS: readonly ContextSection[] = ['perfil', 'ficheros', 'directiva', 'historial', 'git'];

/** `/messages/<tenant>/<alias>?view=context[&tab=...]`: the canonical profile and context page. */
export function AgentSettingsView({ tenantId, alias, conversationPath }: {
  tenantId: string; alias: string; conversationPath: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { agents, live } = useFleet();
  const requested = new URLSearchParams(useRouteSearch()).get('tab');
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const agent = agents.find((candidate) => candidate.tenantId === tenantId && candidate.alias === alias);
  const state = agent ? agentLiveState(agent, live) : undefined;
  return <section className="flex min-h-0 flex-1 flex-col bg-canvas" aria-label={`Perfil y contexto de ${alias}`}>
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3 sm:px-6">
      <LinkButton variant="ghost" size="sm" href={conversationPath} onClick={(event) => { onNavClick(event, conversationPath); }}>
        <ArrowLeft size={16} aria-hidden="true" /> Volver a la conversación
      </LinkButton>
      <AgentContextMenu agent={{ tenantId, alias }} omit={['context']} className="flex min-w-64 flex-1 items-center gap-3">
        <AgentOrb seed={`${tenantId}/${alias}`} state={state} size={36} />
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="m-0 truncate text-[15px] font-semibold tracking-tight">Perfil y contexto de {alias}</h2>
          <p className="m-0 truncate text-xs text-muted">{tenantId} / {alias}</p>
        </div>
        {state ? <StatePill state={state} className="ml-1" /> : null}
        <AgentKebab agent={{ tenantId, alias }} omit={['context']} className="ml-auto size-9" />
      </AgentContextMenu>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 sm:px-6">
        <ErrorBoundary label={`Perfil y contexto de ${alias}`} resetKey={`${tenantId}:${alias}`}>
          <Suspense fallback={<LoadingState label="Abriendo el perfil y contexto del agente…" />}>
            <AgentContextPanel tenantId={tenantId} alias={alias}
              initialSection={SECTIONS.find((section) => section === requested)} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  </section>;
}

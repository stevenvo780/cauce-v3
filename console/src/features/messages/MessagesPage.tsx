import { useEffect, useRef } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { LinkButton } from '../../components/kit';
import { EmptyState, LoadingState } from '../../components/ui';
import { LogoMark } from '../../components/brand/Logo';
import { BOTTOM_BAR_VIEWPORT } from '../../breakpoints';
import { agentHref } from '../../shell/agent-href';
import { rememberChat } from '../../shell/last-chat';
import { useMediaQuery } from '../../shell/use-media-query';
import { useFleet } from '../../shell/fleet-context';
import { permissionState } from '../../lib';
import { onNavClick } from '../../router';
import { fleetAgentId } from '../terminal/fleet';
import { operatorRouteForAgent } from '../terminal/session';
import { ChatLauncher } from './ChatLauncher';
import { ConversationPane } from './ConversationPane';
import { useConversationViewport } from './use-conversation-viewport';

interface MessagesPageProps {
  /** Segments past the route id: `/messages/:tenant/:alias` is the open conversation. */
  params?: readonly string[];
}

/**
 * Interactive messaging view with fleet agents and queue monitoring.
 */
export function MessagesPage({ params }: MessagesPageProps = {}) {
  return <ConsoleAccessBoundary><MessagesPageContent params={params} /></ConsoleAccessBoundary>;
}

function MessagesPageContent({ params }: MessagesPageProps) {
  const fleet = useFleet();
  const access = useConsoleAccess();
  const { agents, salud, live, topology, messages, activity, queues } = fleet;
  const phone = useMediaQuery(BOTTOM_BAR_VIEWPORT);

  const pedido = params?.length === 2 ? { tenantId: params[0], alias: params[1] } : undefined;
  const seleccionado = pedido ? agents.find((agent) => agent.id === fleetAgentId(pedido.tenantId, pedido.alias)) : undefined;
  const accesoVerificado = access.error ? undefined : access.data;
  const topologiaVerificada = topology.error ? undefined : topology.data;
  const canPublish = permissionState(accesoVerificado, 'message.publish') === 'allowed';
  // The messages feed is NOW one of the roster's sources, so it also gates the "the server does
  // not observe this alias" notice: asserting it with a half-loaded feed would be another denial
  // spoken before having the evidence.
  const flotaCargando = fleet.loading;
  const flotaError = fleet.error;

  const envolturaRef = useRef<HTMLDivElement | null>(null);
  useConversationViewport(envolturaRef);

  useEffect(() => { if (seleccionado) rememberChat(agentHref('messages', seleccionado)); }, [seleccionado]);

  const lastSelected = useRef<string | undefined>(undefined);
  const requestedId = pedido ? fleetAgentId(pedido.tenantId, pedido.alias) : undefined;
  useEffect(() => {
    const root = envolturaRef.current;
    if (seleccionado && lastSelected.current !== seleccionado.id) {
      lastSelected.current = seleccionado.id;
      const activeElement = document.activeElement;
      const focusInsideDialog = activeElement?.closest('[role="dialog"]');
      const focusOnExpandedDialogTrigger = activeElement?.getAttribute('aria-haspopup') === 'dialog'
        && activeElement.getAttribute('aria-expanded') === 'true';
      if (!focusInsideDialog && !focusOnExpandedDialogTrigger) {
        root?.querySelector<HTMLElement>('[data-objeto-principal="hilo"] h2')?.focus({ preventScroll: true });
      }
    } else if (!requestedId && lastSelected.current) {
      const previous = lastSelected.current;
      lastSelected.current = undefined;
      const button = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-id]'))
        .find((candidate) => candidate.dataset.agentId === previous);
      button?.focus({ preventScroll: true });
    }
  }, [seleccionado, requestedId]);

  return (
    <div
      ref={envolturaRef}
      data-conversacion={seleccionado || pedido ? 'abierta' : undefined}
      className="flex min-h-0 flex-col bg-surface h-[calc(var(--messenger-viewport-height,100dvh)_-_var(--messenger-top,0px))] max-[760px]:h-[calc(var(--messenger-viewport-height,100dvh)_-_var(--messenger-top,0px)_-_var(--messenger-navigation-height,calc(56px_+_env(safe-area-inset-bottom))))]"
    >
      {seleccionado ? (
        <ConversationPane
          /* Keyed by human and agent: switching agents must remount, or the previous draft,
             selection and scroll position would follow the operator into another thread. */
          key={`${accesoVerificado?.human_subject ?? accesoVerificado?.subject ?? ''}:${seleccionado.id}`}
          agent={seleccionado}
          live={live.get(seleccionado.id)}
          page={messages.data}
          loading={messages.loading}
          error={messages.error}
          route={operatorRouteForAgent(topologiaVerificada, accesoVerificado, seleccionado)}
          canPublish={canPublish}
          publisherSubject={accesoVerificado?.subject}
          publisherHumanSubject={accesoVerificado?.human_subject}
          salud={salud[seleccionado.id]}
          queueError={queues.error ?? activity.error}
          onQueueReload={() => { void queues.reload(); void activity.reload(); }}
          onReload={messages.reload}
        />
      ) : !pedido && phone ? (
        <section aria-label="Conversaciones" data-state="welcome" className="flex min-h-0 flex-1 flex-col"><ChatLauncher phone /></section>
      ) : !pedido ? (
        <section aria-label="Sin conversación abierta" data-state="welcome" className="flex min-h-0 flex-1 flex-col"><ChatLauncher phone={false} /></section>
      ) : (
        <section className="grid flex-1 place-content-center justify-items-center gap-3 p-8 text-center" data-state="missing" aria-label="Sin conversación abierta">
          <LogoMark size={48} />
          <h1 className="m-0 text-2xl font-semibold tracking-tight">No encontramos esa conversación</h1>
          {flotaCargando ? <LoadingState label="Buscando la conversación…" /> : flotaError ? (
            <EmptyState>No se pudo comprobar este agente: {flotaError.message}</EmptyState>
          ) : (
            <p className="m-0 max-w-md text-muted">
              El servidor no observa a <strong className="text-fg">{pedido.tenantId}:{pedido.alias}</strong> en la topología, la presencia,
              ni en el registro de agentes ni en los mensajes. Cauce no inventa un agente que no existe.
            </p>
          )}
          <LinkButton href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }}>Volver a los chats</LinkButton>
        </section>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { EmptyState, LoadingState } from '../../components/ui';
import { LogoMark } from '../../components/brand/Logo';
import { BOTTOM_BAR_VIEWPORT } from '../../breakpoints';
import { AgentList } from '../../shell/AgentList';
import { useMediaQuery } from '../../shell/use-media-query';
import { useFleet } from '../../shell/fleet-context';
import { permissionState } from '../../lib';
import { onNavClick } from '../../router';
import { fleetAgentId } from '../terminal/fleet';
import { operatorRouteForAgent } from '../terminal/session';
import { ConversationPane } from './ConversationPane';
import './messages.css';
import { useConversationViewport } from './use-conversation-viewport';

export const VAR_TOPE_MENSAJERIA = '--messenger-tope';

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
  const { agents, salud, topology, messages, activity, queues } = fleet;
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

  /*
   * -------------------------------------------------- THE COMPOSER, ALSO ON DESKTOP
   *
   * Measured in production at 1280x900: the `textarea` was at y=1546 and the "Send" button at
   * y=1633, i.e. 646 px BELOW the fold, with `position: static` on the composer. The phone fix
   * (commit c2a75d0) does not touch this case: its `position: fixed` lives inside the 760 px
   * cutoff. Here the composer anchors to the bottom of the PANEL, and for that the panel needs
   * a height: `.messenger-shell` grew with its content, so `margin-top: auto` pushed nothing.
   *
   * The height is MEASURED, not hand-written, because it depends on what is above —the page
   * header, the description, and the permission chip occupy different amounts by width and by
   * server text—, and a fixed number in the sheet would push the button off again as soon as
   * someone adds a line. The block's real top is written to the document and the sheet subtracts.
   */
  const envolturaRef = useRef<HTMLDivElement | null>(null);
  const medirElTope = useCallback(() => {
    const envoltura = envolturaRef.current;
    if (!envoltura) return;
    // `+ scrollY` so it is the top within the DOCUMENT and not the viewport: without it the
    // measurement would change with every scroll and the panel would stretch and shrink while the operator reads.
    const tope = Math.round(envoltura.getBoundingClientRect().top + window.scrollY);
    envoltura.style.setProperty(VAR_TOPE_MENSAJERIA, `${String(tope)}px`);
  }, []);
  // No dependency list on purpose: what sits ABOVE the block changes height with the text the
  // server returns (the permission chip, the description), so it is re-measured on every paint.
  // The `resize` listener, on the other hand, is registered once.
  useEffect(medirElTope);
  useEffect(() => {
    window.addEventListener('resize', medirElTope);
    return () => { window.removeEventListener('resize', medirElTope); };
  }, [medirElTope]);

  useConversationViewport(envolturaRef);

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
        root?.querySelector<HTMLElement>('.messenger-thread h2')?.focus({ preventScroll: true });
      }
    } else if (!requestedId && lastSelected.current) {
      const previous = lastSelected.current;
      lastSelected.current = undefined;
      const button = Array.from(root?.querySelectorAll<HTMLButtonElement>('[data-agent-id]') ?? [])
        .find((candidate) => candidate.dataset.agentId === previous);
      button?.focus({ preventScroll: true });
    }
  }, [seleccionado, requestedId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={envolturaRef} data-conversacion={seleccionado || pedido ? 'abierta' : undefined}>
      {seleccionado ? (
        <ConversationPane
          /* Keyed by human and agent: switching agents must remount, or the previous draft,
             selection and scroll position would follow the operator into another thread. */
          key={`${accesoVerificado?.human_subject ?? accesoVerificado?.subject ?? ''}:${seleccionado.id}`}
          agent={seleccionado}
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
      ) : phone && !pedido ? (
        <section aria-label="Conversaciones" className="flex min-h-0 flex-1 flex-col bg-surface pt-3">
          <h1 className="m-0 px-4 pb-3 text-xl font-semibold tracking-tight">Chats</h1>
          <AgentList routeId="messages" />
        </section>
      ) : (
        <section className="grid flex-1 place-content-center justify-items-center gap-3 p-8 text-center" data-state={pedido ? 'missing' : 'welcome'} aria-label="Sin conversación abierta">
          <LogoMark size={48} />
          <h1 className="m-0 text-2xl font-semibold tracking-tight">{pedido ? 'No encontramos esa conversación' : '¿Con quién trabajamos hoy?'}</h1>
          {pedido && flotaCargando ? <LoadingState label="Buscando la conversación…" /> : pedido && flotaError ? (
            <EmptyState>No se pudo comprobar este agente: {flotaError.message}</EmptyState>
          ) : pedido ? (
            <p className="m-0 max-w-md text-muted">
              El servidor no observa a <strong className="text-fg">{pedido.tenantId}:{pedido.alias}</strong> en topología,
              presencia, registro ni mensajes. Cauce no inventa un agente que no existe.
            </p>
          ) : (
            <p className="m-0 max-w-md text-muted">Elegí un agente en la barra lateral para retomar una conversación, compartir una idea o darle una tarea.</p>
          )}
          {pedido ? <a className="button secondary" href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }}>Volver a los chats</a> : null}
        </section>
      )}
    </div>
  );
}

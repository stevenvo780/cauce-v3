import { MessagesSquare, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, PageHeader, PermissionBadge, RefreshButton } from '../../components/ui';
import { permissionState } from '../../lib';
import { navigate } from '../../router';
import { fleetAgentId, type FleetAgent } from '../terminal/fleet';
import { operatorRouteForAgent } from '../terminal/session';
import { AgentRoster } from './AgentRoster';
import { ConversationPane } from './ConversationPane';
import './messages.css';
import { saludDeColaPorAgente } from './queue-health';
import { construirRosterDeMensajeria } from './roster';

/**
 * The name of the CSS variable holding the top of the messenger block within the document.
 *
 * Exported for the same reason as `VAR_ALTO_COMPOSITOR`: the stylesheet READS it and the
 * component WRITES it, and if the two strings drift there is no typecheck, lint or DOM-test
 * failure — the symptom would be the composer falling off-screen again on desktop, which is
 * the defect this exists to close. `messenger-css.test.ts` requires them to be the same.
 */
export const VAR_TOPE_MENSAJERIA = '--messenger-tope';

function suscribirRuta(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => { window.removeEventListener('popstate', callback); };
}

function rutaActual(): string {
  return window.location.pathname;
}

function decodificar(segmento: string): string {
  try {
    return decodeURIComponent(segmento);
  } catch {
    return segmento;
  }
}

/** `/messages/:tenant/:alias` identifies the open conversation; plain `/messages`, none. */
function agenteDeLaRuta(path: string): { tenantId: string; alias: string } | undefined {
  const segmentos = path.split('/').filter(Boolean).map(decodificar);
  if (segmentos[0] !== 'messages' || segmentos.length < 3) return undefined;
  return { tenantId: segmentos[1], alias: segmentos[2] };
}

/**
 * Interactive messaging view with fleet agents and queue monitoring.
 */
export function MessagesPage() {
  const api = useApi();
  const status = useResource('messages-status', () => api.getStatus());
  const topology = useResource('messages-topology', () => api.getTopology());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const messages = useResource('messages-feed', () => api.listMessages());
  const activity = useResource('messages-activity', () => api.getFleetActivity());
  const queues = useResource('messages-queues', () => api.getQueues());

  useIntervalo(messages.reload, 2_500, messages.loading);
  useIntervalo(status.reload, 5_000, status.loading);
  useIntervalo(activity.reload, 5_000, activity.loading);
  useIntervalo(queues.reload, 15_000, queues.loading);
  useIntervalo(topology.reload, 30_000, topology.loading);

  const path = useSyncExternalStore(suscribirRuta, rutaActual, () => '/messages');
  /**
   * The roster is NOT built only from `memberships ∪ presence`. See `roster.ts`: with that single
   * source, a message addressed to an alias without membership or lease showed up nowhere on this
   * screen —the `gaia` case—, and the messages feed is added precisely so a thread with history
   * cannot disappear because of a table nobody touched.
   */
  const agents = useMemo(
    () => construirRosterDeMensajeria({
      status: status.data,
      topology: topology.data,
      activity: activity.error ? undefined : activity.data,
      messages: messages.data,
    }),
    [status.data, topology.data, activity.data, activity.error, messages.data],
  );
  const salud = useMemo(
    () => saludDeColaPorAgente(activity.error ? undefined : activity.data, queues.error ? undefined : queues.data),
    [activity.data, activity.error, queues.data, queues.error],
  );

  const pedido = agenteDeLaRuta(path);
  const seleccionado = pedido ? agents.find((agent) => agent.id === fleetAgentId(pedido.tenantId, pedido.alias)) : undefined;
  const accesoVerificado = access.error ? undefined : access.data;
  const topologiaVerificada = topology.error ? undefined : topology.data;
  const canPublish = permissionState(accesoVerificado, 'message.publish') === 'allowed';
  // The messages feed is NOW one of the roster's sources, so it also gates the "the server does
  // not observe this alias" notice: asserting it with a half-loaded feed would be another denial
  // spoken before having the evidence.
  const flotaCargando = (status.loading && !status.data)
    || (topology.loading && !topology.data)
    || (activity.loading && !activity.data)
    || (messages.loading && !messages.data);
  const flotaError = status.error ?? topology.error;

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

  function abrir(agent: FleetAgent) {
    navigate(`/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`);
  }

  function sincronizar() {
    void status.reload();
    void topology.reload();
    void access.reload();
    void messages.reload();
    void activity.reload();
    void queues.reload();
  }

  return (
    <>
      <PageHeader
        eyebrow="Mensajería durable"
        title="Mensajes"
        description="Una conversación por agente, con el estado de su cola al lado del nombre y un salto directo a su terminal. El actor, el tenant de origen y el canal siguen siendo autoridad del servidor."
        notes={<PermissionBadge access={accesoVerificado} permission="message.publish" />}
        actions={<RefreshButton onClick={sincronizar} loading={messages.loading && !messages.data} />}
      />

      {/*
        `data-conversacion` es para la hoja de estilo, no para la lógica: en pantalla estrecha el
        roster pasa de ser el contenido a ser el conmutador de agente y se encoge a dos filas, para
        que el hilo y su compositor anclado no arranquen a dos pantallas del borde. Ver el bloque
        de 760 px de `messages.css`, que explica por qué el anclaje es a 66 px y no a 0.
      */}
      <div className="messenger-shell" ref={envolturaRef} data-conversacion={seleccionado ? 'abierta' : undefined}>
        <AgentRoster
          agents={agents}
          salud={salud}
          activeAgentId={seleccionado?.id}
          onSelect={abrir}
          loading={flotaCargando}
          error={flotaError}
        />
        {seleccionado ? (
          <ConversationPane
            /*
              The `key` belongs to the ARRAY, not decorative: without it, switching agents keeps
              the previous agent's draft, selected message, and thread position — a draft written
              for zeus would stay in kant's box — and the effect that opens the thread at the
              bottom does not run again, because the component is not remounted.
            */
            key={seleccionado.id}
            agent={seleccionado}
            page={messages.data}
            loading={messages.loading}
            error={messages.error}
            route={operatorRouteForAgent(topologiaVerificada, accesoVerificado, seleccionado)}
            canPublish={canPublish}
            publisherSubject={accesoVerificado?.subject}
            salud={salud[seleccionado.id]}
            onReload={messages.reload}
          />
        ) : (
          <section className="messenger-empty" aria-label="Sin conversación abierta">
            <span aria-hidden="true"><MessagesSquare size={30} /></span>
            <h2>Elegí un agente</h2>
            {pedido && !flotaCargando ? (
              <EmptyState>
                El servidor no observa a <strong>{pedido.tenantId}:{pedido.alias}</strong>: ni en topología, ni en
                presencia, ni en el registro de agentes, ni como emisor o destinatario de un mensaje de la ventana.
                Cauce no inventa un agente que no existe.
              </EmptyState>
            ) : (
              <p>
                Cada conversación muestra el historial durable con ese agente, cómo va su cola y el botón para abrir
                su terminal. El room de origen lo deriva tu topología: no hay que escribirlo.
              </p>
            )}
          </section>
        )}
      </div>

      <p className="trust-callout">
        <ShieldCheck size={17} aria-hidden="true" />
        <span>Sin header Authorization escrito a mano, sin almacenamiento persistente y sin campos de identidad del cliente.</span>
      </p>
    </>
  );
}

function useIntervalo(reload: () => void, milisegundos: number, cargando: boolean) {
  useEffect(() => {
    if (cargando) return;
    const intervalo = window.setInterval(reload, milisegundos);
    return () => { window.clearInterval(intervalo); };
  }, [cargando, milisegundos, reload]);
}

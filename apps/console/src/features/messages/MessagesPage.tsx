import { MessagesSquare, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, PageHeader, PermissionBadge, RefreshButton } from '../../components/ui';
import { permissionState } from '../../lib';
import { navigate } from '../../navigation';
import { buildFleetAgents, fleetAgentId, type FleetAgent } from '../terminal/fleet';
import { operatorRouteForAgent } from '../terminal/session';
import { AgentRoster } from './AgentRoster';
import { ConversationPane } from './ConversationPane';
import './messages.css';
import { saludDeColaPorAgente } from './queue-health';

function suscribirRuta(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
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

/** `/messages/:tenant/:alias` identifica la conversación abierta; `/messages` a secas, ninguna. */
function agenteDeLaRuta(path: string): { tenantId: string; alias: string } | undefined {
  const segmentos = path.split('/').filter(Boolean).map(decodificar);
  if (segmentos[0] !== 'messages' || segmentos.length < 3) return undefined;
  return { tenantId: segmentos[1], alias: segmentos[2] };
}

/**
 * Mensajería con la flota.
 *
 * Lo que había antes era un formulario en el que había que escribir a mano el room y un
 * «Tenant:alias», más una lista plana de tarjetas ordenada por mensaje: para saber si un agente
 * había contestado había que leer las tarjetas de arriba abajo, y el destinatario era un campo
 * de texto libre que sólo fallaba al enviar. Steven lo resumió en una línea —«el de mensajes es
 * horrible, debería ser una suerte de wpp con mejoras para este sistema»— y las mejoras que pide
 * son exactamente las que un WhatsApp no puede dar: cómo va la cola de cada agente y un salto
 * directo a su terminal.
 *
 * Nada de esto duplica Ultimate Terminal. La lógica de flota, ruta de publicación y transcripción
 * es la MISMA (`features/terminal`), reutilizada; lo que cambia es la pantalla y lo único
 * verdaderamente nuevo es la columna de cola, que sale de fundir `/activity` con `/queues`
 * (ver `queue-health.ts`).
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
  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const salud = useMemo(
    () => saludDeColaPorAgente(activity.error ? undefined : activity.data, queues.error ? undefined : queues.data),
    [activity.data, activity.error, queues.data, queues.error],
  );

  const pedido = agenteDeLaRuta(path);
  const seleccionado = pedido ? agents.find((agent) => agent.id === fleetAgentId(pedido.tenantId, pedido.alias)) : undefined;
  const accesoVerificado = access.error ? undefined : access.data;
  const topologiaVerificada = topology.error ? undefined : topology.data;
  const canPublish = permissionState(accesoVerificado, 'message.publish') === 'allowed';
  const flotaCargando = (status.loading && !status.data) || (topology.loading && !topology.data);
  const flotaError = status.error ?? topology.error;

  function abrir(agent: FleetAgent) {
    navigate(`/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`);
  }

  function sincronizar() {
    status.reload();
    topology.reload();
    access.reload();
    messages.reload();
    activity.reload();
    queues.reload();
  }

  return (
    <>
      <PageHeader
        eyebrow="Mensajería durable"
        title="Mensajes"
        description="Una conversación por agente, con el estado de su cola al lado del nombre y un salto directo a su terminal. El actor, el tenant de origen y el canal siguen siendo autoridad del servidor."
        actions={<RefreshButton onClick={sincronizar} loading={messages.loading && !messages.data} />}
      />
      <PermissionBadge access={accesoVerificado} permission="message.publish" />

      <div className="messenger-shell">
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
            agent={seleccionado}
            page={messages.data}
            loading={messages.loading}
            error={messages.error}
            route={operatorRouteForAgent(topologiaVerificada, accesoVerificado, seleccionado)}
            canPublish={canPublish}
            salud={salud[seleccionado.id]}
            onReload={messages.reload}
          />
        ) : (
          <section className="messenger-empty" aria-label="Sin conversación abierta">
            <span aria-hidden="true"><MessagesSquare size={30} /></span>
            <h2>Elegí un agente</h2>
            {pedido && !flotaCargando ? (
              <EmptyState>
                El servidor no observa a <strong>{pedido.tenantId}:{pedido.alias}</strong> ni en presencia ni en topología.
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
    return () => window.clearInterval(intervalo);
  }, [cargando, milisegundos, reload]);
}

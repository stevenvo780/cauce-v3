import { MessagesSquare, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, PageHeader, PermissionBadge, RefreshButton } from '../../components/ui';
import { permissionState } from '../../lib';
import { navigate } from '../../navigation';
import { fleetAgentId, type FleetAgent } from '../terminal/fleet';
import { operatorRouteForAgent } from '../terminal/session';
import { AgentRoster } from './AgentRoster';
import { ConversationPane } from './ConversationPane';
import './messages.css';
import { saludDeColaPorAgente } from './queue-health';
import { construirRosterDeMensajeria } from './roster';

/**
 * El nombre de la variable CSS con el tope del bloque de mensajería dentro del documento.
 *
 * Se exporta por lo mismo que `VAR_ALTO_COMPOSITOR`: la hoja la LEE y el componente la ESCRIBE, y
 * si las dos cadenas se separan no falla el typecheck, ni el lint, ni una prueba de DOM — el
 * síntoma sería el compositor volviendo a caer fuera de pantalla en escritorio, que es el defecto
 * que esto viene a cerrar. `messenger-css.test.ts` exige que sean la misma.
 */
export const VAR_TOPE_MENSAJERIA = '--messenger-tope';

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
 * Vista de mensajería interactiva con agentes de la flota y monitoreo de colas.
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
   * El roster NO se construye sólo con `memberships ∪ presence`. Ver `roster.ts`: con esa única
   * fuente, un mensaje dirigido a un alias sin membresía ni lease no aparecía en ninguna parte de
   * esta pantalla —el caso `gaia`—, y el feed de mensajes entra acá justamente para que un hilo
   * con historia no pueda desaparecer por una tabla que nadie tocó.
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
  // El feed de mensajes es AHORA una de las fuentes del roster, así que también gatea el aviso
  // de «el servidor no observa a este alias»: afirmarlo con el feed a medio cargar sería otra
  // negativa dicha antes de tener la evidencia.
  const flotaCargando = (status.loading && !status.data)
    || (topology.loading && !topology.data)
    || (activity.loading && !activity.data)
    || (messages.loading && !messages.data);
  const flotaError = status.error ?? topology.error;

  /*
   * -------------------------------------------------- EL COMPOSITOR, TAMBIÉN EN ESCRITORIO
   *
   * Medido en producción a 1280x900: el `textarea` estaba en y=1546 y el botón «Enviar» en
   * y=1633, o sea 646 px POR DEBAJO del pliegue, con `position: static` en el compositor. El
   * arreglo del teléfono (commit c2a75d0) no toca este caso: su `position: fixed` vive dentro del
   * corte de 760 px. Acá el compositor se ancla al pie del PANEL, y para eso el panel necesita un
   * alto: `.messenger-shell` crecía con su contenido, así que `margin-top: auto` no empujaba nada.
   *
   * El alto se MIDE en vez de escribirse a mano porque depende de lo que hay encima —la cabecera
   * de página, la descripción y el chip de permiso ocupan distinto según el ancho y según el texto
   * del servidor—, y un número fijo en la hoja volvería a dejar el botón fuera en cuanto alguien
   * agregue una línea. Se escribe el tope real del bloque en el documento y la hoja resta.
   */
  const envolturaRef = useRef<HTMLDivElement | null>(null);
  const medirElTope = useCallback(() => {
    const envoltura = envolturaRef.current;
    if (!envoltura) return;
    // `+ scrollY` para que sea el tope en el DOCUMENTO y no en la ventana: sin eso la medida
    // cambia con cada scroll y el panel se estiraría y encogería mientras el operador lee.
    const tope = Math.round(envoltura.getBoundingClientRect().top + window.scrollY);
    envoltura.style.setProperty(VAR_TOPE_MENSAJERIA, `${tope}px`);
  }, []);
  // Sin lista de dependencias a propósito: lo que hay ENCIMA del bloque cambia de alto con el
  // texto que devuelve el servidor (el chip de permiso, la descripción), así que se remide en
  // cada pintada. El oyente de `resize`, en cambio, se registra una sola vez.
  useEffect(medirElTope);
  useEffect(() => {
    window.addEventListener('resize', medirElTope);
    return () => window.removeEventListener('resize', medirElTope);
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
        actions={<RefreshButton onClick={sincronizar} loading={messages.loading && !messages.data} />}
      />
      <PermissionBadge access={accesoVerificado} permission="message.publish" />

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
              La `key` es del ARREGLO, no decorativa: sin ella, cambiar de agente conserva el
              borrador, el mensaje seleccionado y la posición del hilo del agente anterior — un
              borrador escrito para zeus quedaba en la caja de kant— y el efecto que abre el hilo
              por el final no se vuelve a ejecutar, porque el componente no se monta otra vez.
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
    return () => window.clearInterval(intervalo);
  }, [cargando, milisegundos, reload]);
}

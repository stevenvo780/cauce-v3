import { ChevronDown, CircleOff, DoorClosed, LockKeyhole, RefreshCw, Send, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useApi } from '../../api/context';
import type { DeliveryView, JobLane, MessagePage } from '../../api/types';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, createId, safeDeliveryState, safeJobLane } from '../../lib';
import { onNavClick } from '../../navigation';
import { fleetAgentId } from '../terminal/fleet';
import { transcriptForSession, type OperatorRoute, type OperatorSession } from '../terminal/session';
import { TerminalTranscript } from '../terminal/TerminalTranscript';
import { MessageTimeline } from './MessageTimeline';
import { LIMITE_MENSAJES, textoDeCifra, type SaludDeCola } from './queue-health';
import { fueraDeLaTopologia, motivoDeAgenteSuelto, type AgenteDeMensajeria } from './roster';

/**
 * El nombre de la variable CSS que reserva, al pie del hilo, el hueco del compositor fijo.
 *
 * Se exporta para que la prueba pueda exigir que la hoja y el componente digan LA MISMA cadena.
 * Un `style.setProperty` con un nombre que ningún `var()` lee no es un error para nadie —ni para
 * el typecheck, ni para el lint, ni para las pruebas de DOM— y el síntoma sería el final del hilo
 * viviendo debajo del compositor, en el teléfono, sin una línea en ninguna consola.
 */
export const VAR_ALTO_COMPOSITOR = '--messenger-composer-alto';

interface ConversationPaneProps {
  agent: AgenteDeMensajeria;
  page?: MessagePage;
  loading: boolean;
  error?: Error;
  route: OperatorRoute;
  canPublish: boolean;
  salud?: SaludDeCola;
  onReload: () => void;
}

/** Ruta del detalle del bot, que es donde vive su terminal (feed durable + PTY cuando existe). */
function rutaDeTui(agent: AgenteDeMensajeria): string {
  return `/fleet/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
}

/**
 * El hilo con UN agente: cabecera con su estado y su cola, historial, y el campo para escribirle.
 *
 * El historial y el envío no se reimplementan: `transcriptForSession` y `TerminalTranscript`
 * son los mismos que usa Ultimate Terminal, y el room de origen lo deriva `operatorRouteForAgent`
 * a partir de la topología del actor. El formulario viejo pedía el room y un «Tenant:alias» a
 * mano; eso no era información que el operador tuviera que aportar, era una forma de equivocarse.
 */
export function ConversationPane({ agent, page, loading, error, route, canPublish, salud, onReload }: ConversationPaneProps) {
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [roomElegido, setRoomElegido] = useState<string>();
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [deliveryElegida, setDeliveryElegida] = useState<string>();
  /**
   * El lane vuelve a ser del operador. El formulario anterior lo dejaba elegir `batch` y esta
   * pantalla lo había fijado en `interactive`: publicar una tarea larga por el carril interactivo
   * la pone a competir con los turnos en vivo, y desde la consola no había forma de evitarlo.
   */
  const [lane, setLane] = useState<JobLane>('interactive');

  const sesion: OperatorSession = useMemo(() => ({
    id: `messenger:${agent.id}`, agent, sourceRoomId: '', openedAt: new Date(0).toISOString(), mode: 'transcript',
  }), [agent]);
  const hilo = useMemo(() => transcriptForSession(page, sesion), [page, sesion]);

  const roomOrigen = roomElegido && route.sourceRoomIds.includes(roomElegido)
    ? roomElegido
    : route.sourceRoomIds[0] ?? '';
  const puedeEnviar = canPublish && route.allowed && Boolean(roomOrigen);
  // Se selecciona el ITEM, no la entrega suelta: el detalle tiene que poder decir el room, el
  // lane, el actor y el trace del MENSAJE, y esos campos no viven en la entrega.
  const itemSeleccionado = hilo.find((item) => item.delivery?.delivery_id === deliveryElegida) ?? hilo.at(-1);
  const seleccionada = itemSeleccionado?.delivery;
  const mensajeSeleccionado = itemSeleccionado?.message;
  // Las entregas HERMANAS del mismo publish: el fan-out completo. La lista plana anterior las
  // mostraba todas y el hilo por par las había dejado fuera, así que desde acá no se podía saber
  // a quién más había ido el mismo mensaje ni cómo le fue.
  const hermanas = (mensajeSeleccionado?.deliveries ?? []).filter((entrega) => (
    fleetAgentId(entrega.recipient_tenant ?? '', entrega.recipient_alias ?? '') !== agent.id
  ));
  const totalVisible = (page?.items ?? []).length;

  /*
   * En pantalla estrecha el compositor es `position: fixed` y por tanto SALE DEL FLUJO: sin
   * reservar su alto al pie del hilo, la última burbuja y el detalle del mensaje quedan debajo de
   * la barra para siempre. El alto no se puede escribir a mano en la hoja porque es variable —el
   * selector de room aparece sólo con más de un room, y los avisos de permiso, de ruta y de
   * publicación suman filas—, así que se MIDE. En escritorio la variable existe igual y no la lee
   * nadie: el `var()` sólo está dentro del corte de 760 px.
   */
  const hiloRef = useRef<HTMLElement | null>(null);
  const compositorRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const hilo = hiloRef.current;
    const compositor = compositorRef.current;
    if (!hilo || !compositor) return;
    const anotar = () => {
      hilo.style.setProperty(VAR_ALTO_COMPOSITOR, `${Math.ceil(compositor.getBoundingClientRect().height)}px`);
    };
    anotar();
    // jsdom no trae `ResizeObserver`, y tampoco lo traen navegadores viejos. Sin observador queda
    // la medida inicial, que es mejor que nada y nunca peor que el valor por defecto de la hoja.
    if (typeof ResizeObserver !== 'function') return;
    const observador = new ResizeObserver(anotar);
    observador.observe(compositor);
    return () => observador.disconnect();
  }, []);

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const texto = draft.trim();
    if (!puedeEnviar || !texto) return;
    setEnviando(true);
    setAviso(undefined);
    try {
      const resultado = await api.publishMessage({
        room_id: roomOrigen,
        recipients: [{ tenant_id: agent.tenantId, alias: agent.alias }],
        body: { text: texto },
        lane,
        // La MISMA prioridad por carril que publicaba el formulario anterior: interactivo 10,
        // batch 0. No es una constante nueva, es la que ya estaba y se perdió con el rediseño.
        priority: lane === 'interactive' ? 10 : 0,
        idempotency_key: createId(`consola-mensajes-${agent.alias}`),
      });
      setDraft('');
      setAviso({ tone: 'success', text: `Aceptado por el control plane · ${compactId(resultado.message_id)}. El ACK llega por polling.` });
      onReload();
    } catch (causa) {
      setAviso({ tone: 'error', text: causa instanceof Error ? causa.message : 'No se pudo publicar el mensaje.' });
    } finally {
      setEnviando(false);
    }
  }

  function teclaDelCompositor(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section className="messenger-thread" ref={hiloRef} aria-label={`Conversación con ${agent.alias}`}>
      <header className="messenger-thread-head">
        <div className="messenger-thread-identity">
          <span className={`messenger-avatar ${agent.leaseState}`} aria-hidden="true">{agent.alias.slice(0, 2).toUpperCase()}</span>
          <div>
            <h2>{agent.alias}</h2>
            <p className="eyebrow">{agent.tenantId} · epoch {agent.presence?.epoch ?? 'UNKNOWN'} · lease <Time value={agent.presence?.lease_expires_at ?? agent.presence?.lease_until} /></p>
          </div>
          <Badge tone={agent.leaseState === 'online' ? 'online' : agent.leaseState === 'expired' ? 'offline' : 'unknown'}>{agent.leaseState}</Badge>
        </div>
        <div className="messenger-thread-actions">
          <a
            className="button small secondary"
            href={rutaDeTui(agent)}
            onClick={(event) => onNavClick(event, rutaDeTui(agent))}
            title={`Abrir la terminal de ${agent.alias} (feed durable y PTY cuando el servidor lo declara)`}
          ><TerminalSquare size={14} aria-hidden="true" /> Abrir TUI</a>
          <button className="button small secondary" type="button" onClick={onReload} disabled={loading}>
            <RefreshCw size={13} aria-hidden="true" /> Sincronizar
          </button>
        </div>
      </header>

      {fueraDeLaTopologia(agent) ? (
        <p className="messenger-loose-note" role="note">
          <DoorClosed size={14} aria-hidden="true" /> {motivoDeAgenteSuelto(agent)}
        </p>
      ) : null}

      <dl className="messenger-queue-strip" aria-label={`Cola de ${agent.alias}`}>
        <div><dt>En cola</dt><dd>{textoDeCifra(salud?.pendientes)}</dd></div>
        <div><dt>En curso</dt><dd>{textoDeCifra(salud?.enCurso)}</dd></div>
        <div><dt>Reintentos</dt><dd>{textoDeCifra(salud?.reintentos)}</dd></div>
        <div data-alarm={(salud?.muertas ?? 0) > 0 || undefined}>
          <dt>Muertas</dt>
          <dd>{salud?.muertasTruncadas && salud.muertas !== undefined ? '≥ ' : ''}{textoDeCifra(salud?.muertas)}</dd>
        </div>
      </dl>

      {/*
        El techo del servidor se DICE, no se disimula. `listMessages` corta en 100 mensajes
        globales y no acepta filtro por par (medido en packages/store/src/repository.ts), así que
        este hilo es un filtro de cliente sobre esa ventana: en una flota cargada puede verse
        vacío sin que eso pruebe que no hay historia. Un hilo vacío mudo sería una afirmación
        falsa, y de esas ya hubo demasiadas en esta consola.
      */}
      <p className="messenger-window-note" data-truncated={totalVisible >= LIMITE_MENSAJES || undefined}>
        {totalVisible >= LIMITE_MENSAJES
          ? `Ventana llena: el servidor devuelve como máximo ${LIMITE_MENSAJES} mensajes de TODA la flota y este hilo se filtra sobre ellos. Puede haber historia anterior que no entra.`
          : `Hilo filtrado sobre los ${totalVisible} mensajes que el servidor publica para tu identidad (tope ${LIMITE_MENSAJES}, sin filtro por par).`}
      </p>

      {error && !page ? (
        <div role="alert"><EmptyState>No se pudo leer el feed de mensajes: {error.message}</EmptyState></div>
      ) : loading && !page ? (
        <LoadingState label="Abriendo el feed durable de mensajes…" />
      ) : (
        <TerminalTranscript
          key={agent.id}
          items={hilo}
          selectedDeliveryId={seleccionada?.delivery_id ?? undefined}
          onSelectDelivery={(delivery: DeliveryView) => delivery.delivery_id && setDeliveryElegida(delivery.delivery_id)}
        />
      )}

      {/*
        EL DETALLE DEL MENSAJE, COMPLETO.

        La lista plana anterior mostraba por tarjeta el room, el lane, el actor verificado, el
        tenant, el trace ENTERO y TODAS las entregas del publish con su tenant destino. El hilo
        por par se quedó sólo con el cuerpo, el `msg` compacto y el `trace` compacto, y ninguno de
        esos campos es decorativo: el trace es lo que se pega en `/chains/:traceId`, el actor es la
        autoridad del servidor sobre quién publicó, y las entregas hermanas son la única forma de
        ver a quién MÁS fue el mismo mensaje. Todo eso vuelve acá.
      */}
      {mensajeSeleccionado ? (
        <div className="messenger-delivery-detail" role="group" aria-label="Detalle del mensaje seleccionado">
          <p className="eyebrow">
            {seleccionada
              ? <>Entrega {compactId(seleccionada.delivery_id)} → {seleccionada.recipient_tenant ?? 'UNKNOWN'}:{seleccionada.recipient_alias ?? 'UNKNOWN'}</>
              : <>Mensaje {compactId(mensajeSeleccionado.message_id)} · sin entrega para este par</>}
          </p>
          <dl className="messenger-message-meta">
            <div><dt>Room</dt><dd><Unknown value={mensajeSeleccionado.room_id} /></dd></div>
            <div><dt>Lane</dt><dd><Unknown value={safeJobLane(mensajeSeleccionado.lane)} /></dd></div>
            <div><dt>Actor verificado</dt><dd><Unknown value={mensajeSeleccionado.actor_alias} /></dd></div>
            <div><dt>Tenant de origen</dt><dd><Unknown value={mensajeSeleccionado.tenant_id} /></dd></div>
            <div><dt>Publicado</dt><dd><Time value={mensajeSeleccionado.created_at} /></dd></div>
            {/* Enteros y seleccionables: un trace recortado no sirve para buscar la cadena. */}
            <div><dt>Trace</dt><dd className="mono">{mensajeSeleccionado.trace_id ?? 'UNKNOWN'}</dd></div>
            <div><dt>Message id</dt><dd className="mono">{mensajeSeleccionado.message_id ?? 'UNKNOWN'}</dd></div>
            {seleccionada ? (
              <>
                <div><dt>Tenant destino</dt><dd><Unknown value={seleccionada.recipient_tenant} /></dd></div>
                <div><dt>Delivery id</dt><dd className="mono">{seleccionada.delivery_id ?? 'UNKNOWN'}</dd></div>
              </>
            ) : null}
          </dl>
          {seleccionada ? <MessageTimeline events={seleccionada.timeline} /> : null}
          <section className="messenger-fanout" aria-label="Entregas hermanas del mismo publish">
            <p className="eyebrow">Fan-out del publish</p>
            {hermanas.length === 0 ? (
              <p className="messenger-fanout-none">
                Este publish sólo tiene la entrega de este hilo. No es lo mismo que «no se sabe»: el servidor
                devolvió {(mensajeSeleccionado.deliveries ?? []).length} entrega(s) para el mensaje.
              </p>
            ) : (
              <ul className="messenger-fanout-list">
                {hermanas.map((entrega, indice) => (
                  <li key={entrega.delivery_id ?? indice}>
                    <strong>{entrega.recipient_tenant ?? 'UNKNOWN'}:{entrega.recipient_alias ?? 'UNKNOWN'}</strong>
                    <Badge tone={safeDeliveryState(entrega.status) === 'done' ? 'done'
                      : safeDeliveryState(entrega.status) === 'failed' || safeDeliveryState(entrega.status) === 'dead' ? 'danger'
                        : entrega.status ? 'running' : 'unknown'}>
                      <Unknown value={safeDeliveryState(entrega.status)} />
                    </Badge>
                    <span className="mono">{compactId(entrega.delivery_id)}</span>
                    <span>intento {entrega.attempt ?? 'UNKNOWN'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      <form className="terminal-composer messenger-composer" ref={compositorRef} onSubmit={(event) => void enviar(event)}>
        <label htmlFor={`messenger-input-${agent.id}`}>Mensaje para {agent.alias}</label>
        {route.sourceRoomIds.length > 1 ? (
          <label className="messenger-room-select">Room de origen
            <span className="room-select-wrap">
              <select value={roomOrigen} onChange={(event) => setRoomElegido(event.target.value)}>
                {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>
        ) : (
          <p className="messenger-room-fixed">Room de origen: <span className="mono">{roomOrigen || 'UNKNOWN'}</span> · derivado de tu topología, no escrito a mano.</p>
        )}
        <label className="messenger-lane-select" htmlFor={`messenger-lane-${agent.id}`}>Lane
          <span className="room-select-wrap">
            <select
              id={`messenger-lane-${agent.id}`}
              value={lane}
              onChange={(event) => setLane(event.target.value === 'batch' ? 'batch' : 'interactive')}
            >
              <option value="interactive">Interactive · prioridad 10</option>
              <option value="batch">Batch · prioridad 0</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
        <textarea
          id={`messenger-input-${agent.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={teclaDelCompositor}
          rows={3}
          maxLength={8_000}
          placeholder={agent.leaseState === 'online' ? 'Escribí un mensaje…' : 'El agente no tiene lease vigente; Cauce puede encolar el mensaje igual.'}
          disabled={!puedeEnviar || enviando}
        />
        <div className="composer-footer">
          <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
          <button className="button primary" type="submit" disabled={!puedeEnviar || enviando || !draft.trim()}>
            <Send size={15} aria-hidden="true" /> {enviando ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
        {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere el permiso message.publish.</p> : null}
        {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
        {aviso ? <p className={`notice ${aviso.tone}`} role={aviso.tone === 'error' ? 'alert' : 'status'}>{aviso.text}</p> : null}
      </form>
    </section>
  );
}

import { ArrowDownToLine, ChevronDown, CircleOff, DoorClosed, LockKeyhole, RefreshCw, Send, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { JobLane, MessagePage } from '../../api/types';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, safeJobLane } from '../../lib';
import { LEASE_LABEL, LEASE_TONE } from '../../vocabulario';
import { onNavClick } from '../../router';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada, textoDelCuerpo } from '../terminal/cuerpo-del-mensaje';
import { fleetAgentId } from '../terminal/fleet';
import { transcriptForSession, type OperatorRoute, type OperatorSession, type TranscriptItem } from '../terminal/session';
import { TerminalTranscript } from '../terminal/TerminalTranscript';
import { estaPegadoAlFinal, irAlFinal } from './desplazamiento';
import { publishDurably } from './durable-publish';
import { MessageTimeline } from './MessageTimeline';
import { LIMITE_MENSAJES, textoDeCifra, type SaludDeCola } from './queue-health';
import { fueraDeLaTopologia, motivoDeAgenteSuelto, type AgenteDeMensajeria } from './roster';

/**
 * The name of the CSS variable that reserves, at the foot of the thread, the slot for the fixed composer.
 *
 * It is exported so the test can require the stylesheet and the component to say THE SAME string. A `style.setProperty`
 * with a name no `var()` reads is not an error for anyone —neither for typecheck, nor lint, nor DOM tests— and the
 * symptom would be the end of the thread living under the composer, on the phone, without a line in any console.
 */
export const VAR_ALTO_COMPOSITOR = '--messenger-composer-alto';

interface ConversationPaneProps {
  agent: AgenteDeMensajeria;
  page?: MessagePage;
  loading: boolean;
  error?: Error;
  route: OperatorRoute;
  canPublish: boolean;
  publisherSubject?: string | null;
  salud?: SaludDeCola;
  onReload: () => void;
}

/** Bot detail route, where its terminal lives (durable feed + PTY when it exists). */
function rutaDeTui(agent: AgenteDeMensajeria): string {
  return `/terminal/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
}

/** What the console knows about the full body of a message: nothing, requesting it, the text, or a failure. */
type CuerpoEntero =
  | { estado: 'pidiendo' }
  | { estado: 'listo'; texto: string }
  | { estado: 'fallo'; motivo: string };

/**
 * Conversation panel with an agent: history, delivery state and message composer.
 */
export function ConversationPane({
  agent, page, loading, error, route, canPublish, publisherSubject, salud, onReload,
}: ConversationPaneProps) {
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [roomElegido, setRoomElegido] = useState<string>();
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [mensajeElegido, setMensajeElegido] = useState<string>();
  const [cuerpos, setCuerpos] = useState<Record<string, CuerpoEntero>>({});
  /** The detail is born closed and is opened by the operator or by clicking a bubble. */
  const [detalleAbierto, setDetalleAbierto] = useState(false);
  const [lane, setLane] = useState<JobLane>('interactive');

  const sesion: OperatorSession = useMemo(() => ({
    id: `messenger:${agent.id}`, agent, sourceRoomId: '', openedAt: new Date(0).toISOString(), mode: 'transcript',
  }), [agent]);
  const hilo = useMemo(() => transcriptForSession(page, sesion), [page, sesion]);

  const roomOrigen = roomElegido && route.sourceRoomIds.includes(roomElegido)
    ? roomElegido
    : route.sourceRoomIds[0] ?? '';
  const puedeEnviar = canPublish && route.allowed && Boolean(roomOrigen);
  /*
   * The lease warning is a WARNING, not a hint about what to write. It lived in the textarea's
   * `placeholder`, so it erased itself at the first keystroke —exactly when it starts to matter—
   * and no screen reader announced it as anything. `note` and not `alert` for the same reason
   * `MutationBar` uses it: this is derived in the browser, not a refusal from the server.
   */
  const avisoDeLease = agent.leaseState === 'online' ? undefined
    : agent.leaseState === 'expired'
      ? `El lease de ${agent.alias} está vencido: Cauce encola el mensaje igual y se lo entrega cuando el agente vuelva a reclamar.`
      : `El servidor no informa el lease de ${agent.alias} (sin dato, que no es lo mismo que vencido): Cauce encola el mensaje igual.`;
  // The ITEM is selected, not the loose delivery: the detail has to be able to say the room, the lane, the actor and the trace of the MESSAGE, and those fields do not live in the delivery.
  const elegidoPorElOperador = hilo.find((item) => (
    mensajeElegido != null && item.message.message_id === mensajeElegido
  ));
  const itemSeleccionado = elegidoPorElOperador ?? hilo.at(-1);
  const seleccionada = itemSeleccionado?.delivery;
  const rutaDeEntregaSeleccionada = queueDeliveryPath(seleccionada?.delivery_id);
  const mensajeSeleccionado = itemSeleccionado?.message;
  // SIBLING deliveries of the same publish: the complete fan-out. The previous flat list showed all of them and the
  // thread-by-pair had left them out, so from here it was impossible to know who else the same message went to or how it went.
  const hermanas = (mensajeSeleccionado?.deliveries ?? []).filter((entrega) => (
    fleetAgentId(entrega.recipient_tenant ?? '', entrega.recipient_alias ?? '') !== agent.id
  ));
  const totalVisible = (page?.items ?? []).length;

  /*
   * On a narrow screen the composer is `position: fixed` and therefore LEAVES THE FLOW: without reserving its height
   * at the foot of the thread, the last bubble and the message detail stay under the bar forever. The height cannot
   * be written by hand in the stylesheet because it varies —the room selector only appears with more than one room,
   * and the permission, route and publish notices add rows—, so it is MEASURED. On desktop the variable exists as well
   * and nobody reads it: the `var()` only lives inside the 760 px breakpoint.
   */
  const hiloRef = useRef<HTMLElement | null>(null);
  const compositorRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const hilo = hiloRef.current;
    const compositor = compositorRef.current;
    if (!hilo || !compositor) return;
    const anotar = () => {
      hilo.style.setProperty(VAR_ALTO_COMPOSITOR, `${String(Math.ceil(compositor.getBoundingClientRect().height))}px`);
    };
    anotar();
    // jsdom does not bundle `ResizeObserver`, nor do old browsers. Without an observer we are left with the initial measurement, which is better than nothing and never worse than the stylesheet's default value.
    if (typeof ResizeObserver !== 'function') return;
    const observador = new ResizeObserver(anotar);
    observador.observe(compositor);
    return () => { observador.disconnect(); };
  }, []);

  /*
   * --------------------------------------------------- THE THREAD STARTS AT THE END
   *
   * A messenger opens at the last thing said. This one used to open at the first: see `desplazamiento.ts`, where
   * the measurement lives. There is ONE single scrolling box —`.messenger-thread-scroll`, which wraps the transcript
   * and nothing else— precisely so "go to the end" has a single destination: before, the transcript had its own
   * `max-height` with scroll INSIDE the page's scroll, and neither of them started where it was needed.
   *
   * The message detail stays OUTSIDE the box on purpose: if it were inside, "go to the end" would land at the foot of
   * the detail and not at the last bubble.
   */
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const pegadoRef = useRef(true);
  const [pegado, setPegado] = useState(true);
  const [vistosHastaAqui, setVistosHastaAqui] = useState(0);

  const alFinal = useCallback((suave: boolean) => {
    const caja = cajaRef.current;
    if (!caja) return;
    irAlFinal(caja, suave);
    pegadoRef.current = true;
    setPegado(true);
    setVistosHastaAqui(hilo.length);
  }, [hilo.length]);

  const ultimoId = hilo.at(-1)?.message.message_id;
  useEffect(() => {
    // On mount (or when changing agent, which remounts by the `key`) and every time a new message arrives, BUT only if
    // the operator was watching the end: dragging them from where they were reading would be the opposite bug.
    if (!pegadoRef.current) return;
    const caja = cajaRef.current;
    if (!caja) return;
    irAlFinal(caja, false);
    setVistosHastaAqui(hilo.length);
  }, [ultimoId, hilo.length]);

  function alDesplazar() {
    const caja = cajaRef.current;
    if (!caja) return;
    const abajo = estaPegadoAlFinal(caja);
    pegadoRef.current = abajo;
    setPegado(abajo);
    if (abajo) setVistosHastaAqui(hilo.length);
  }

  const nuevosSinVer = Math.max(0, hilo.length - vistosHastaAqui);

  /** Requests the full body of a message. The 240-char trimming is done by the server, not the view. */
  const pedirCuerpo = useCallback(async (messageId: string) => {
    setCuerpos((previo) => ({ ...previo, [messageId]: { estado: 'pidiendo' } }));
    try {
      const detalle = await api.getMessage(messageId);
      const texto = textoDelCuerpo(detalle.body);
      setCuerpos((previo) => ({
        ...previo,
        [messageId]: texto === undefined
          ? { estado: 'fallo', motivo: 'El servidor devolvió el mensaje sin cuerpo.' }
          : { estado: 'listo', texto },
      }));
    } catch (causa) {
      /*
       * A 404 here does not mean "the message does not exist": it means that the deployed gateway does not yet
       * publish this route. It is said with those words instead of blaming the data, which is the mistake this
       * console makes when something is missing: blaming what is visible.
       */
      const motivo = causa instanceof ApiError && (causa.status === 404 || causa.status === 501)
        ? 'El gateway desplegado no publica todavía GET /v3/console/messages/:id, así que el cuerpo entero no se puede pedir desde acá.'
        : causa instanceof Error ? causa.message : 'No se pudo leer el cuerpo del mensaje.';
      setCuerpos((previo) => ({ ...previo, [messageId]: { estado: 'fallo', motivo } }));
    }
  }, [api]);

  async function enviar(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const texto = draft.trim();
    if (!puedeEnviar || !texto) return;
    setEnviando(true);
    setAviso(undefined);
    try {
      const semantics = {
        room_id: roomOrigen,
        recipients: [{ tenant_id: agent.tenantId, alias: agent.alias }],
        body: { text: texto },
        lane,
        // The SAME priority per lane the previous form published: interactive 10, batch 0. It is not a new constant —it was the one that was already there and got lost in the redesign.
        priority: lane === 'interactive' ? 10 : 0,
      } satisfies Omit<Parameters<typeof api.publishMessage>[0], 'idempotency_key'>;
      const { receipt: resultado, reconciled, journalStatus } = await publishDurably({
        api,
        input: semantics,
        publisherSubject,
        expectedDeliveries: 1,
        reconcile: onReload,
      });

      setDraft('');
      setAviso({
        tone: 'success',
        text: `${reconciled ? 'Publicación reconciliada desde el journal durable' : 'Aceptado por el control plane'} · ${compactId(resultado.message_id)}. `
          + `${journalStatus === 'confirmed'
            ? 'Intención confirmada'
            : journalStatus === 'pending'
              ? 'Confirmación incierta; intención pendiente y cercada'
              : 'Confirmación rechazada; intención cercada contra duplicados'}; el ACK llega por polling.`,
      });
      // What one just wrote is watched: publishing sticks the thread back to the end.
      pegadoRef.current = true;
      setPegado(true);
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

  function elegir(item: TranscriptItem) {
    if (!item.message.message_id) return;
    setMensajeElegido(item.message.message_id);
    // Clicking a bubble IS asking for its detail: opening it here is not "auto-opening".
    setDetalleAbierto(true);
  }

  const idSeleccionado = mensajeSeleccionado?.message_id ?? undefined;
  const cuerpoEntero = idSeleccionado ? cuerpos[idSeleccionado] : undefined;
  const recorteSeleccionado = previsualizacionRecortada(mensajeSeleccionado?.body_preview);

  return (
    <section className="messenger-thread" data-objeto-principal="hilo" ref={hiloRef} aria-label={`Conversación con ${agent.alias}`}>
      <header className="messenger-thread-head">
        <div className="messenger-thread-identity">
          <span className={`messenger-avatar ${agent.leaseState}`} aria-hidden="true">{agent.alias.slice(0, 2).toUpperCase()}</span>
          <div>
            <h2>{agent.alias}</h2>
            <p className="eyebrow">{agent.tenantId} · epoch {agent.presence?.epoch ?? 'UNKNOWN'} · lease <Time value={agent.presence?.lease_expires_at ?? agent.presence?.lease_until} /></p>
          </div>
          <Badge tone={LEASE_TONE[agent.leaseState]}>{LEASE_LABEL[agent.leaseState]}</Badge>
        </div>
        <div className="messenger-thread-actions">
          <a
            className="button small secondary"
            href={rutaDeTui(agent)}
            onClick={(event) => { onNavClick(event, rutaDeTui(agent)); }}
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

      {/* Thread filtered over the server's message window. */}
      <div className="messenger-thread-scroll" ref={cajaRef} onScroll={alDesplazar}>
        <p className="messenger-window-note" data-truncated={totalVisible >= LIMITE_MENSAJES || undefined}>
          {totalVisible >= LIMITE_MENSAJES
            ? `Ventana llena: el servidor devuelve como máximo ${String(LIMITE_MENSAJES)} mensajes de TODA la flota y este hilo se filtra sobre ellos. Puede haber historia anterior que no entra.`
            : `Hilo filtrado sobre los ${String(totalVisible)} mensajes que el servidor publica para tu identidad (tope ${String(LIMITE_MENSAJES)}, sin filtro por par).`}
        </p>
        {error && !page ? (
          <div role="alert"><EmptyState>No se pudo leer el feed de mensajes: {error.message}</EmptyState></div>
        ) : loading && !page ? (
          <LoadingState label="Abriendo el feed durable de mensajes…" />
        ) : (
          <TerminalTranscript
            key={agent.id}
            items={hilo}
            selectedMessageId={elegidoPorElOperador?.message.message_id ?? undefined}
            onSelectItem={elegir}
          />
        )}
      </div>

      {/*
        "Go to the end", with the count of what arrived while the operator was reading above. It only appears when
        needed: if they are already at the bottom, a button that goes nowhere.
      */}
      {!pegado && hilo.length > 0 ? (
        <div className="messenger-al-final">
          <button className="button small" type="button" onClick={() => { alFinal(true); }}>
            <ArrowDownToLine size={14} aria-hidden="true" />
            {nuevosSinVer > 0 ? `Ir al último · ${String(nuevosSinVer)} nuevo${nuevosSinVer === 1 ? '' : 's'}` : 'Ir al último'}
          </button>
        </div>
      ) : null}

      {mensajeSeleccionado ? (
        <details
          className="messenger-delivery-detail"
          role="group"
          aria-label="Detalle del mensaje seleccionado"
          open={detalleAbierto}
          onToggle={(evento) => { setDetalleAbierto(evento.currentTarget.open); }}
        >
          <summary className="messenger-detalle-origen">
            {elegidoPorElOperador
              ? <>Mensaje que elegiste · <span className="mono">{compactId(mensajeSeleccionado.message_id)}</span></>
              /* It names the control that DOES select —the delivery row, or the "ver detalle" of a
                 bubble without one—: clicking the text of a bubble selects nothing, and the
                 previous wording ("clicá una burbuja") promised exactly that. */
              : <>Último mensaje del hilo · <span className="mono">{compactId(mensajeSeleccionado.message_id)}</span> · clicá la entrega de una burbuja, o su «ver detalle», para ver la suya</>}
          </summary>
          <p className="eyebrow">
            {seleccionada
              ? <>
                Entrega {compactId(seleccionada.delivery_id)} → {seleccionada.recipient_tenant ?? 'UNKNOWN'}:{seleccionada.recipient_alias ?? 'UNKNOWN'}
                {rutaDeEntregaSeleccionada ? <>{' '}· <a
                  href={rutaDeEntregaSeleccionada}
                  onClick={(event) => { onNavClick(event, rutaDeEntregaSeleccionada); }}
                  aria-label={`Gestionar delivery ${seleccionada.delivery_id ?? 'UNKNOWN'} en Colas`}
                >Gestionar en Colas</a></> : null}
              </>
              : <>Mensaje {compactId(mensajeSeleccionado.message_id)} · sin entrega para este par</>}
          </p>

          <section className="messenger-cuerpo" aria-label="Cuerpo del mensaje">
            <p className="eyebrow">Cuerpo</p>
            {cuerpoEntero?.estado === 'listo' ? (
              <pre className="messenger-cuerpo-texto">{cuerpoEntero.texto}</pre>
            ) : (
              <pre className="messenger-cuerpo-texto" data-recortado={recorteSeleccionado || undefined}>
                {mensajeSeleccionado.body_preview ?? 'Contenido no incluido por el servidor.'}{recorteSeleccionado ? '…' : ''}
              </pre>
            )}
            {cuerpoEntero?.estado === 'fallo' ? (
              <p className="messenger-cuerpo-aviso" role="alert">{cuerpoEntero.motivo}</p>
            ) : null}
            {recorteSeleccionado && cuerpoEntero?.estado !== 'listo' ? (
              <p className="messenger-cuerpo-aviso">
                La lista publica sólo los primeros {CARACTERES_DE_PREVISUALIZACION} caracteres de cada mensaje
                (<span className="mono">left(body,{CARACTERES_DE_PREVISUALIZACION})</span> en el servidor).{' '}
                <button
                  className="button small secondary"
                  type="button"
                  disabled={!idSeleccionado || cuerpoEntero?.estado === 'pidiendo'}
                  onClick={() => idSeleccionado && void pedirCuerpo(idSeleccionado)}
                >{cuerpoEntero?.estado === 'pidiendo' ? 'Pidiendo…' : 'Ver el mensaje completo'}</button>
              </p>
            ) : null}
          </section>

          <dl className="messenger-message-meta">
            <div><dt>Room</dt><dd><Unknown value={mensajeSeleccionado.room_id} /></dd></div>
            <div><dt>Carril</dt><dd><Unknown value={safeJobLane(mensajeSeleccionado.lane)} /></dd></div>
            <div><dt>Actor verificado</dt><dd><Unknown value={mensajeSeleccionado.actor_alias} /></dd></div>
            <div><dt>Tenant de origen</dt><dd><Unknown value={mensajeSeleccionado.tenant_id} /></dd></div>
            <div><dt>Publicado</dt><dd><Time value={mensajeSeleccionado.created_at} /></dd></div>
            {/* Integers and selectable: a trimmed trace is no use for searching the chain. */}
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
                {hermanas.map((entrega, indice) => {
                  const policy = deliveryPolicy(entrega.status);
                  const queuePath = queueDeliveryPath(entrega.delivery_id);
                  return <li key={entrega.delivery_id ?? indice}>
                    <strong>{entrega.recipient_tenant ?? 'UNKNOWN'}:{entrega.recipient_alias ?? 'UNKNOWN'}</strong>
                    <Badge tone={policy.tone}>
                      <Unknown
                        value={policy.known ? policy.label : undefined}
                        motivo={entrega.status && !policy.known
                          ? `El servidor mandó un estado que esta consola no conoce: ${entrega.status}`
                          : undefined}
                      />
                    </Badge>
                    <span className="mono">{compactId(entrega.delivery_id)}</span>
                    <span>intento {entrega.attempt ?? 'UNKNOWN'}</span>
                    {queuePath ? <a
                      href={queuePath}
                      onClick={(event) => { onNavClick(event, queuePath); }}
                      aria-label={`Gestionar delivery ${entrega.delivery_id ?? 'UNKNOWN'} en Colas`}
                    >Gestionar en Colas</a> : null}
                  </li>;
                })}
              </ul>
            )}
          </section>
        </details>
      ) : null}

      <form className="terminal-composer messenger-composer" ref={compositorRef} onSubmit={(event) => void enviar(event)}>
        <label htmlFor={`messenger-input-${agent.id}`}>Mensaje para {agent.alias}</label>
        {route.sourceRoomIds.length > 1 ? (
          <label className="messenger-room-select">Room de origen
            <span className="room-select-wrap">
              <select value={roomOrigen} onChange={(event) => { setRoomElegido(event.target.value); }}>
                {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>
        ) : (
          <p className="messenger-room-fixed">Room de origen: <span className="mono">{roomOrigen || 'UNKNOWN'}</span> · derivado de tu topología, no escrito a mano.</p>
        )}
        <label className="messenger-lane-select" htmlFor={`messenger-lane-${agent.id}`}>Carril
          <span className="room-select-wrap">
            <select
              id={`messenger-lane-${agent.id}`}
              value={lane}
              onChange={(event) => { setLane(event.target.value === 'batch' ? 'batch' : 'interactive'); }}
            >
              {/* El rótulo es castellano; el VALOR se escribe como lo publica el protocolo, que es
                  lo que el operador va a cruzar contra `lane=` en el log del servidor. */}
              <option value="interactive">interactive · prioridad 10</option>
              <option value="batch">batch · prioridad 0</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
        {avisoDeLease ? <p className="notice parcial" role="note">{avisoDeLease}</p> : null}
        <textarea
          id={`messenger-input-${agent.id}`}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={teclaDelCompositor}
          rows={3}
          maxLength={8_000}
          placeholder="Escribí un mensaje…"
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

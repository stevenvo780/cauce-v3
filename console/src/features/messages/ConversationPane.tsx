import { ArrowDownToLine, ChevronDown, CircleOff, DoorClosed, LockKeyhole, RefreshCw, Send, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { JobLane, MessagePage } from '../../api/types';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import { onNavClick } from '../../router';
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
  publisherSubject?: string | null;
  salud?: SaludDeCola;
  onReload: () => void;
}

/** Ruta del detalle del bot, que es donde vive su terminal (feed durable + PTY cuando existe). */
function rutaDeTui(agent: AgenteDeMensajeria): string {
  return `/fleet/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
}

/** Lo que la consola sabe del cuerpo entero de un mensaje: nada, pidiéndolo, el texto, o el fallo. */
type CuerpoEntero =
  | { estado: 'pidiendo' }
  | { estado: 'listo'; texto: string }
  | { estado: 'fallo'; motivo: string };

/**
 * Panel de conversación con un agente: historial, estado de entrega y compositor de mensajes.
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
  /** El detalle nace cerrado y lo abre el operador o al hacer clic en una burbuja. */
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
  // Se selecciona el ITEM, no la entrega suelta: el detalle tiene que poder decir el room, el
  // lane, el actor y el trace del MENSAJE, y esos campos no viven en la entrega.
  const elegidoPorElOperador = hilo.find((item) => (
    mensajeElegido != null && item.message.message_id === mensajeElegido
  ));
  const itemSeleccionado = elegidoPorElOperador ?? hilo.at(-1);
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
      hilo.style.setProperty(VAR_ALTO_COMPOSITOR, `${String(Math.ceil(compositor.getBoundingClientRect().height))}px`);
    };
    anotar();
    // jsdom no trae `ResizeObserver`, y tampoco lo traen navegadores viejos. Sin observador queda
    // la medida inicial, que es mejor que nada y nunca peor que el valor por defecto de la hoja.
    if (typeof ResizeObserver !== 'function') return;
    const observador = new ResizeObserver(anotar);
    observador.observe(compositor);
    return () => { observador.disconnect(); };
  }, []);

  /*
   * ------------------------------------------------------------------ EL HILO EMPIEZA POR EL FINAL
   *
   * Un mensajero abre por lo último dicho. Este abría por lo primero: ver `desplazamiento.ts`,
   * donde está la medida. Hay UNA sola caja con scroll —`.messenger-thread-scroll`, que envuelve
   * la transcripción y nada más— justamente para que «ir al final» tenga un único destino: antes
   * la transcripción tenía su propio `max-height` con scroll DENTRO del scroll de la página, y
   * ninguno de los dos empezaba donde hacía falta.
   *
   * El detalle del mensaje queda FUERA de la caja a propósito: si estuviera dentro, «ir al
   * último» aterrizaría al pie del detalle y no en la última burbuja.
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
    // Al montar (o al cambiar de agente, que remonta por la `key`) y cada vez que llega un mensaje
    // nuevo, PERO sólo si el operador estaba mirando el final: arrastrarlo desde donde está
    // leyendo sería el defecto contrario.
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

  /** Pide el cuerpo entero de un mensaje. El recorte a 240 lo hace el servidor, no la vista. */
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
       * Un 404 acá no significa «no existe el mensaje»: significa que el gateway desplegado
       * todavía no publica esta ruta. Se dice con esas palabras en vez de acusar al dato, que es
       * el error que esta consola comete cuando algo no está: culpar a lo que se ve.
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
        // La MISMA prioridad por carril que publicaba el formulario anterior: interactivo 10,
        // batch 0. No es una constante nueva, es la que ya estaba y se perdió con el rediseño.
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
      // Lo que uno acaba de escribir se mira: publicar vuelve a pegar el hilo al final.
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
    // Clicar una burbuja ES pedir su detalle: abrirlo acá no es «abrirse solo».
    setDetalleAbierto(true);
  }

  const idSeleccionado = mensajeSeleccionado?.message_id ?? undefined;
  const cuerpoEntero = idSeleccionado ? cuerpos[idSeleccionado] : undefined;
  const recorteSeleccionado = previsualizacionRecortada(mensajeSeleccionado?.body_preview);

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

      {/* Hilo filtrado sobre la ventana de mensajes del servidor. */}
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
        «Ir al último», con el conteo de lo que llegó mientras el operador leía más arriba. Sólo
        aparece cuando hace falta: si ya está abajo, un botón que no lleva a ningún sitio.
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
              : <>Último mensaje del hilo · <span className="mono">{compactId(mensajeSeleccionado.message_id)}</span> · clicá una burbuja para ver la suya</>}
          </summary>
          <p className="eyebrow">
            {seleccionada
              ? <>Entrega {compactId(seleccionada.delivery_id)} → {seleccionada.recipient_tenant ?? 'UNKNOWN'}:{seleccionada.recipient_alias ?? 'UNKNOWN'}</>
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
        <label className="messenger-lane-select" htmlFor={`messenger-lane-${agent.id}`}>Lane
          <span className="room-select-wrap">
            <select
              id={`messenger-lane-${agent.id}`}
              value={lane}
              onChange={(event) => { setLane(event.target.value === 'batch' ? 'batch' : 'interactive'); }}
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
          onChange={(event) => { setDraft(event.target.value); }}
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

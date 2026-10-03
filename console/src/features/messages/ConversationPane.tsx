import { ArrowDownToLine, ArrowLeft, ChevronDown, CircleOff, LockKeyhole, RefreshCw, Send, Settings2, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent, type KeyboardEvent } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { JobLane, MessagePage } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { useConversationDraft } from './conversation-drafts';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, safeJobLane } from '../../lib';
import { LEASE_LABEL, LEASE_TONE } from '../../vocabulario';
import { onNavClick, useRouteSearch } from '../../router';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada, textoDelCuerpo } from '../terminal/cuerpo-del-mensaje';
import { fleetAgentId } from '../terminal/fleet';
import { transcriptForSession, type OperatorRoute, type OperatorSession, type TranscriptItem } from '../terminal/session';
import { TerminalTranscript } from '../terminal/TerminalTranscript';
import { estaPegadoAlFinal, irAlFinal } from './desplazamiento';
import { publishDurably } from './durable-publish';
import { ConversationMenu } from './ConversationMenu';
import { ConversationNotices } from './ConversationNotices';
import { AgentSettingsView } from './AgentSettingsView';
import { MessageTimeline } from './MessageTimeline';
import { useCanonicalReply, type CanonicalReplyRoot } from './use-canonical-reply';
import { LIMITE_MENSAJES, textoDeCifra, type SaludDeCola } from './queue-health';
import { fueraDeLaTopologia, motivoDeAgenteSuelto, type AgenteDeMensajeria } from './roster';

interface ConversationPaneProps {
  agent: AgenteDeMensajeria;
  page?: MessagePage;
  loading: boolean;
  error?: Error;
  route: OperatorRoute;
  canPublish: boolean;
  publisherSubject?: string | null;
  publisherHumanSubject?: string | null;
  salud?: SaludDeCola;
  queueError?: Error;
  onQueueReload: () => void;
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
  agent, page, loading, error, route, canPublish, publisherSubject, publisherHumanSubject, salud, queueError, onQueueReload, onReload,
}: ConversationPaneProps) {
  const api = useApi();
  const search = useRouteSearch();
  const contextOpen = new URLSearchParams(search).get('view') === 'context';
  const conversationPath = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const wasContextOpen = useRef(contextOpen);
  useEffect(() => {
    if (wasContextOpen.current && !contextOpen) moreTrigger.current?.focus({ preventScroll: true });
    wasContextOpen.current = contextOpen;
  }, [contextOpen]);
  const replySubject = publisherHumanSubject ?? publisherSubject;
  const draftKey = JSON.stringify([replySubject, agent.id]);
  const [form, updateForm] = useConversationDraft(draftKey);
  const { text: draft, roomId: roomElegido, lane, sending: enviando, notice: aviso } = form;
  const setDraft = (text: string) => { updateForm((current) => ({ ...current, text })); };
  const setRoomElegido = (roomId: string) => { updateForm((current) => ({ ...current, roomId })); };
  const setLane = (lane: JobLane) => { updateForm((current) => ({ ...current, lane })); };
  const setAviso = (notice: typeof aviso) => { updateForm((current) => ({ ...current, notice })); };
  const [mensajeElegido, setMensajeElegido] = useState<string>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<TranscriptItem>();
  const [receiptRoot, setReceiptRoot] = useState<{ key: string; root: CanonicalReplyRoot }>();
  const [cuerpos, setCuerpos] = useState<Record<string, CuerpoEntero>>({});
  /** The detail is born closed and is opened by the operator or by clicking a bubble. */
  const [detalleAbierto, setDetalleAbierto] = useState(false);

  const sesion: OperatorSession = useMemo(() => ({
    id: `messenger:${agent.id}`, agent, sourceRoomId: '', openedAt: new Date(0).toISOString(), mode: 'transcript',
  }), [agent]);
  const hilo = useMemo(() => transcriptForSession(page, sesion), [page, sesion]);
  const replyScopeKey = JSON.stringify([replySubject, agent.tenantId, agent.alias]);

  const roomUnavailable = Boolean(roomElegido && !route.sourceRoomIds.includes(roomElegido));
  const roomOrigen = roomElegido ?? (route.sourceRoomIds.length === 1 ? route.sourceRoomIds[0] : '');
  const needsRoomChoice = route.sourceRoomIds.length > 1 || roomUnavailable;
  const puedeEnviar = canPublish && route.allowed && Boolean(roomOrigen) && !roomUnavailable;
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
  const selectedInWindow = hilo.find((item) => (
    mensajeElegido != null && item.message.message_id === mensajeElegido
  ));
  useEffect(() => {
    // Retain the latest observed delivery and timeline when polling moves this message out of the window.
    if (selectedInWindow) setSelectedSnapshot(selectedInWindow);
  }, [selectedInWindow]);
  const elegidoPorElOperador = selectedInWindow ?? selectedSnapshot;
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

  const mensajePropio = (item: TranscriptItem | undefined) => Boolean(
    replySubject && item?.message.author?.kind === 'human'
      && item.message.author.subject_id === replySubject,
  );
  const deliveryDelAgente = (item: TranscriptItem | undefined) => {
    const delivery = item?.delivery;
    return delivery?.recipient_tenant === agent.tenantId && delivery.recipient_alias === agent.alias
      && typeof delivery.delivery_id === 'string' && delivery.delivery_id.length > 0;
  };
  const receiptDeliveryFromFeed = receiptRoot?.key === replyScopeKey
    ? hilo.find((item) => item.message.message_id === receiptRoot.root.messageId
      && item.delivery?.delivery_id === receiptRoot.root.deliveryId
      && item.delivery.recipient_tenant === agent.tenantId
      && item.delivery.recipient_alias === agent.alias)?.delivery
    : undefined;
  const rootFromReceipt: CanonicalReplyRoot | undefined = receiptRoot?.key === replyScopeKey
    ? { ...receiptRoot.root, status: receiptDeliveryFromFeed?.status ?? receiptRoot.root.status }
    : undefined;
  const selectedReplyRoot = mensajePropio(elegidoPorElOperador) && deliveryDelAgente(elegidoPorElOperador)
    ? { messageId: elegidoPorElOperador?.message.message_id ?? '', deliveryId: elegidoPorElOperador?.delivery?.delivery_id ?? '', status: elegidoPorElOperador?.delivery?.status }
    : undefined;
  const latestOwnRoot = [...hilo].reverse().find((item) => mensajePropio(item) && deliveryDelAgente(item));
  const candidateRoot = mensajeElegido
    ? selectedReplyRoot
    : rootFromReceipt ? rootFromReceipt
      : latestOwnRoot ? {
        messageId: latestOwnRoot.message.message_id ?? '',
        deliveryId: latestOwnRoot.delivery?.delivery_id ?? '',
        status: latestOwnRoot.delivery?.status,
      } : undefined;
  const canonical = useCanonicalReply({ publisherSubject: replySubject, tenantId: agent.tenantId, alias: agent.alias, root: candidateRoot });

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
  const scrollPosition = useRef(0);
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
    if (contextOpen) return;
    const caja = cajaRef.current;
    if (!caja) return;
    if (!pegadoRef.current) { caja.scrollTop = scrollPosition.current; return; }
    irAlFinal(caja, false);
    setVistosHastaAqui(hilo.length);
  }, [canonical.reply?.chainOpen, canonical.reply?.messageId, canonical.reply?.reply, contextOpen, ultimoId, hilo.length]);

  function alDesplazar() {
    const caja = cajaRef.current;
    if (!caja) return;
    scrollPosition.current = caja.scrollTop;
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
      const motivo = causa instanceof ApiError && (causa.status === 404 || causa.status === 501)
        ? `No se pudo obtener el cuerpo completo (HTTP ${String(causa.status)}). El servidor no devolvió el contenido; la vista previa sigue disponible.`
        : causa instanceof Error ? causa.message : 'No se pudo leer el cuerpo del mensaje.';
      setCuerpos((previo) => ({ ...previo, [messageId]: { estado: 'fallo', motivo } }));
    }
  }, [api]);

  async function enviar(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const texto = draft.trim();
    if (!puedeEnviar || !texto || enviando) return;
    updateForm((current) => ({ ...current, sending: true }));
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

      updateForm((current) => ({ ...current, text: current.text === draft ? '' : current.text }));
      const receiptDeliveryId = resultado.delivery_ids?.[0];
      if (resultado.message_id && receiptDeliveryId) {
        setReceiptRoot({ key: replyScopeKey, root: { messageId: resultado.message_id, deliveryId: receiptDeliveryId } });
        setMensajeElegido(undefined);
        setSelectedSnapshot(undefined);
      }
      setAviso({
        tone: journalStatus === 'confirmed' ? 'success' : 'parcial',
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
      updateForm((current) => ({ ...current, sending: false }));
    }
  }

  function teclaDelCompositor(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function elegir(item: TranscriptItem) {
    if (!item.message.message_id) return;
    detailTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMensajeElegido(item.message.message_id);
    setSelectedSnapshot(item);
    // Clicking a bubble IS asking for its detail: opening it here is not "auto-opening".
    setDetalleAbierto(true);
    detailHeading.current?.focus({ preventScroll: true });
  }

  function closeDetail() {
    setDetalleAbierto(false);
    const trigger = detailTrigger.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else moreTrigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (detalleAbierto) detailHeading.current?.focus({ preventScroll: true });
  }, [detalleAbierto, mensajeElegido]);

  const idSeleccionado = mensajeSeleccionado?.message_id ?? undefined;
  const cuerpoEntero = idSeleccionado ? cuerpos[idSeleccionado] : undefined;
  const recorteSeleccionado = previsualizacionRecortada(mensajeSeleccionado?.body_preview);

  if (contextOpen) return <AgentSettingsView tenantId={agent.tenantId} alias={agent.alias} conversationPath={conversationPath} />;

  return (
    <section className="messenger-thread" data-objeto-principal="hilo" aria-label={`Conversación con ${agent.alias}`}>
      <header className="messenger-thread-head">
        <div className="messenger-thread-identity">
          <a className="chat-back" href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }} aria-label="Volver a los agentes"><ArrowLeft size={20} aria-hidden="true" /></a>
          <AgentAvatar alias={agent.alias} tenantId={agent.tenantId} state={agent.leaseState} working={(salud?.enCurso ?? 0) > 0} />
          <div>
            <h2 tabIndex={-1}>{agent.alias}</h2>
            <p className="chat-agent-subtitle">{agent.tenantId}</p>
          </div>
          <Badge tone={LEASE_TONE[agent.leaseState]}>{LEASE_LABEL[agent.leaseState]}</Badge>
        </div>
        <ConversationMenu triggerRef={moreTrigger}>
          <a className="button small secondary" href={`${conversationPath}?view=context`}
            onClick={(event) => { onNavClick(event, `${conversationPath}?view=context`); }}>
            <Settings2 size={14} aria-hidden="true" /> Configurar agente
          </a>
          <a
            className="button small secondary"
            href={rutaDeTui(agent)}
            onClick={(event) => { onNavClick(event, rutaDeTui(agent)); }}
            title={`Abrir la terminal de ${agent.alias} (feed durable y PTY cuando el servidor lo declara)`}
          ><TerminalSquare size={14} aria-hidden="true" /> Abrir TUI</a>
          <button className="button small secondary" type="button" onClick={onReload} disabled={loading}>
            <RefreshCw size={13} aria-hidden="true" /> Sincronizar
          </button>
          {itemSeleccionado ? <button className="button small secondary" type="button"
            disabled={!hilo.at(-1)?.message.message_id} onClick={() => { const last = hilo.at(-1); if (last) elegir(last); }}>
            Ver detalle del último mensaje
          </button> : null}
          <p className="messenger-room-fixed">Room de origen: <span className="mono">{roomOrigen || 'UNKNOWN'}</span> · derivado de tu topología, no escrito a mano.</p>
          <label className="messenger-lane-select" htmlFor={`messenger-lane-${agent.id}`}>Carril
            <select id={`messenger-lane-${agent.id}`} value={lane} disabled={enviando}
              onChange={(event) => { setLane(event.target.value === 'batch' ? 'batch' : 'interactive'); }}>
              <option value="interactive">interactive · prioridad 10</option>
              <option value="batch">batch · prioridad 0</option>
            </select>
          </label>
          <details className="chat-agent-details">
            <summary>Estado y detalles del agente{(salud?.muertas ?? 0) > 0 || (salud?.reintentos ?? 0) > 0 ? ' · Hay entregas que necesitan atención' : ''}</summary>
            <p className="chat-agent-runtime">Epoch {agent.presence?.epoch ?? 'UNKNOWN'} · lease <Time value={agent.presence?.lease_expires_at ?? agent.presence?.lease_until} /></p>
            <dl className="messenger-queue-strip" aria-label={`Cola de ${agent.alias}`}>
              <div><dt>En cola</dt><dd>{textoDeCifra(salud?.pendientes)}</dd></div>
              <div><dt>En curso</dt><dd>{textoDeCifra(salud?.enCurso)}</dd></div>
              <div><dt>Reintentos</dt><dd>{textoDeCifra(salud?.reintentos)}</dd></div>
              <div data-alarm={(salud?.muertas ?? 0) > 0 || undefined}>
                <dt>Muertas</dt>
                <dd>{salud?.muertasTruncadas && salud.muertas !== undefined ? '≥ ' : ''}{textoDeCifra(salud?.muertas)}</dd>
              </div>
            </dl>
            <p className="messenger-window-note">Hilo filtrado sobre los {totalVisible} mensajes que el servidor publica para tu identidad (tope {LIMITE_MENSAJES}, sin filtro por par).</p>
          </details>
          {aviso?.tone === 'success' ? <details className="chat-agent-details">
            <summary>Recibo del último envío</summary>
            <p className="notice success">{aviso.text}</p>
            <p>La aceptación no confirma la ejecución. El estado de entrega se consulta en el hilo.</p>
          </details> : null}
        </ConversationMenu>
      </header>

      <ConversationNotices health={salud} queueError={queueError} feedError={page ? error : undefined}
        leaseWarning={avisoDeLease} leaseExpired={agent.leaseState === 'expired'}
        topologyWarning={fueraDeLaTopologia(agent) ? motivoDeAgenteSuelto(agent) : undefined}
        onQueueReload={onQueueReload} fallbackFocusRef={moreTrigger} />

      {/* Thread filtered over the server's message window. */}
      <div className="messenger-thread-scroll" ref={cajaRef} onScroll={alDesplazar}>
        {totalVisible >= LIMITE_MENSAJES ? <p className="messenger-window-note" data-truncated role="note">
          Ventana llena: el servidor devuelve como máximo {LIMITE_MENSAJES} mensajes de TODA la flota y este hilo se filtra sobre ellos. Puede haber historia anterior que no entra.
        </p> : null}
        {error && !page ? (
          <div role="alert"><EmptyState>No se pudo leer el feed de mensajes: {error.message}</EmptyState></div>
        ) : loading && !page ? (
          <LoadingState label="Abriendo el feed durable de mensajes…" />
        ) : (
          <TerminalTranscript
            presentation="chat"
            key={agent.id}
            items={hilo}
            selectedMessageId={elegidoPorElOperador?.message.message_id ?? undefined}
            onSelectItem={elegir}
            canonicalReply={canonical.reply}
            canonicalReplyStale={canonical.stale}
            onCanonicalReplyRetry={canonical.retry}
          />
        )}
      </div>

      {canonical.error ? <p className="messenger-cuerpo-aviso" role="status">
        {canonical.accessDenied ? 'La respuesta canónica ya no está disponible para esta identidad o destinatario.'
          : canonical.stale ? 'No se pudo actualizar la respuesta canónica; se conserva el último dato como desactualizado.'
            : 'No se pudo leer la respuesta canónica.'}
        <button className="button small secondary" type="button" onClick={canonical.retry}>Releer respuesta</button>
      </p> : null}

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

      {detalleAbierto && mensajeSeleccionado ? (
        <section className="messenger-delivery-detail" role="group" aria-label="Detalle del mensaje seleccionado"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } }}>
          <header className="chat-inspector-head">
            <h3 ref={detailHeading} tabIndex={-1}>{elegidoPorElOperador ? 'Mensaje que elegiste' : 'Último mensaje del hilo'}</h3>
            <button className="button small secondary" type="button" onClick={closeDetail} aria-label="Cerrar detalle"><X size={16} aria-hidden="true" /></button>
          </header>
          {mensajeElegido && !hilo.some((item) => item.message.message_id === mensajeElegido)
            ? <p className="messenger-window-note" role="note">Mensaje fuera de la ventana actual; se muestra el último detalle recibido.</p> : null}
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
                {mensajeSeleccionado.deliveries == null ? 'El servidor no incluyó las entregas de este mensaje.'
                  : `El servidor devolvió ${String(mensajeSeleccionado.deliveries.length)} entrega(s) para el mensaje; ninguna otra entrega fuera de este hilo.`}
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
        </section>
      ) : null}

      <form className="messenger-composer" onSubmit={(event) => void enviar(event)}>
        <label className="sr-only" htmlFor={`messenger-input-${agent.id}`}>Mensaje para {agent.alias}</label>
        {needsRoomChoice ? (
          <label className="messenger-room-select">Room de origen
            <span className="room-select-wrap">
              <select value={roomOrigen} disabled={enviando} onChange={(event) => { setRoomElegido(event.target.value); }}>
                <option value="" disabled>Elegí la sala de origen</option>
                {roomUnavailable ? <option value={roomElegido} disabled>{roomElegido} · no disponible</option> : null}
                {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>
        ) : null}
        {roomUnavailable ? <p className="composer-blocked" role="alert">La sala elegida ya no está disponible. Elegí otra sala antes de enviar; el borrador se conserva.</p>
          : route.allowed && !roomOrigen ? <p className="composer-blocked" role="note">Elegí una sala de origen antes de enviar.</p> : null}
        {lane === 'batch' ? <p className="messenger-room-fixed">Envío en segundo plano · cambiá el carril en Más.</p> : null}
        <div className="composer-input-row">
        <textarea
          id={`messenger-input-${agent.id}`}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={teclaDelCompositor}
          rows={1}
          maxLength={8_000}
          placeholder="Escribí un mensaje…"
          disabled={!puedeEnviar || enviando}
        />
        <div className="composer-footer">
          <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
          <button className="button primary" type="submit" disabled={!puedeEnviar || enviando || !draft.trim()}>
            <Send size={15} aria-hidden="true" /><span>{enviando ? 'Enviando…' : 'Enviar'}</span>
          </button>
        </div>
        </div>
        {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere el permiso message.publish.</p> : null}
        {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
        {aviso?.tone === 'success'
          ? <span className="sr-only" role="status">Mensaje aceptado para entrega. La aceptación no confirma la ejecución.</span>
          : aviso ? <p className={`notice ${aviso.tone}`} role={aviso.tone === 'error' ? 'alert' : 'status'}>{aviso.text}</p> : null}
      </form>
    </section>
  );
}

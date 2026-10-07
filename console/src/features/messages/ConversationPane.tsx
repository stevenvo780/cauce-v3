import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { MessagePage } from '../../api/types';
import { Button } from '../../components/kit';
import { EmptyState, LoadingState } from '../../components/ui';
import { compactId } from '../../lib';
import { useRouteSearch } from '../../router';
import type { LiveAgentView } from '../live/agent-state';
import { liveStateOf } from '../terminal/fleet';
import { textoDelCuerpo } from '../terminal/cuerpo-del-mensaje';
import { transcriptForSession, type OperatorRoute, type OperatorSession, type TranscriptItem } from '../terminal/session';
import { AgentSettingsView } from './AgentSettingsView';
import { snapshotAttachments } from './chat-attachments';
import { ChatAttachmentsComposer } from './chat-attachments-composer';
import { ChatHeader } from './ChatHeader';
import type { FullBody } from './ChatMessage';
import { ChatThread } from './ChatThread';
import { useConversationDraft } from './conversation-drafts';
import { ConversationNotices } from './ConversationNotices';
import { estaPegadoAlFinal, irAlFinal } from './desplazamiento';
import { publishDurably } from './durable-publish';
import { MessageDetail } from './MessageDetail';
import { LIMITE_MENSAJES, type SaludDeCola } from './queue-health';
import { fueraDeLaTopologia, motivoDeAgenteSuelto, type AgenteDeMensajeria } from './roster';
import { useCanonicalReply, type CanonicalReplyRoot } from './use-canonical-reply';

const apiDraftScopes = new WeakMap<object, number>();
let nextApiDraftScope = 0;

function conversationDraftKey(api: object, subject: string | null | undefined, agentId: string): string {
  let scope = apiDraftScopes.get(api);
  if (scope === undefined) {
    scope = ++nextApiDraftScope;
    apiDraftScopes.set(api, scope);
  }
  return JSON.stringify([scope, subject, agentId]);
}

interface ConversationPaneProps {
  agent: AgenteDeMensajeria;
  /** The same live view the sidebar reads; absent when activity does not report the agent. */
  live?: LiveAgentView;
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

/**
 * Conversation with one agent: thread, delivery state and composer. Remounted per human, agent and
 * API so a draft, a selection or a late receipt never follows the operator into another scope.
 */
export function ConversationPane(props: ConversationPaneProps) {
  const api = useApi();
  const key = conversationDraftKey(api, props.publisherHumanSubject ?? props.publisherSubject, props.agent.id);
  return <ConversationPaneContent key={key} {...props} />;
}

function ConversationPaneContent({
  agent, live, page, loading, error, route, canPublish, publisherSubject, publisherHumanSubject, salud, queueError, onQueueReload, onReload,
}: ConversationPaneProps) {
  const api = useApi();
  const search = useRouteSearch();
  const contextOpen = new URLSearchParams(search).get('view') === 'context';
  const conversationPath = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const wasContextOpen = useRef(contextOpen);
  useEffect(() => {
    if (wasContextOpen.current && !contextOpen) moreTrigger.current?.focus({ preventScroll: true });
    wasContextOpen.current = contextOpen;
  }, [contextOpen]);
  const replySubject = publisherHumanSubject ?? publisherSubject;
  const draftKey = conversationDraftKey(api, replySubject, agent.id);
  const [form, updateForm] = useConversationDraft(draftKey);
  const { text: draft, files: archivos, roomId: roomElegido, lane, sending: enviando, notice: aviso } = form;
  const setDraft = (text: string) => { updateForm((current) => ({ ...current, text })); };
  const setAviso = (notice: typeof aviso) => { updateForm((current) => ({ ...current, notice })); };
  const [mensajeElegido, setMensajeElegido] = useState<string>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<TranscriptItem>();
  const submissions = useRef(new Set<string>());
  const [receiptRoot, setReceiptRoot] = useState<{ key: string; root: CanonicalReplyRoot }>();
  const [cuerpos, setCuerpos] = useState<Record<string, FullBody>>({});
  const [confirmandoPublicacion, setConfirmandoPublicacion] = useState(false);
  const [detalleAbierto, setDetalleAbierto] = useState(false);
  const [detailFocusRequest, setDetailFocusRequest] = useState(0);

  const sesion: OperatorSession = useMemo(() => ({
    id: `messenger:${agent.id}`, agent, sourceRoomId: '', openedAt: new Date(0).toISOString(), mode: 'transcript',
  }), [agent]);
  const hilo = useMemo(() => transcriptForSession(page, sesion), [page, sesion]);
  const replyScopeKey = JSON.stringify([draftKey, agent.tenantId, agent.alias]);
  const publishScope = useMemo(() => ({ key: replyScopeKey, api, publisherSubject }), [api, publisherSubject, replyScopeKey]);
  const activePublishScope = useRef<typeof publishScope | undefined>(publishScope);
  useEffect(() => {
    activePublishScope.current = publishScope;
    return () => { activePublishScope.current = undefined; };
  }, [publishScope]);

  const roomUnavailable = Boolean(roomElegido && !route.sourceRoomIds.includes(roomElegido));
  const roomOrigen = roomElegido ?? (route.sourceRoomIds.length === 1 ? route.sourceRoomIds[0] : '');
  const needsRoomChoice = route.sourceRoomIds.length > 1 || roomUnavailable;
  const puedeEnviar = canPublish && route.allowed && Boolean(roomOrigen) && !roomUnavailable;
  // A warning, not a hint: it must survive typing, so it never lives in the placeholder.
  const avisoDeLease = agent.leaseState === 'online' ? undefined
    : agent.leaseState === 'expired'
      ? `El lease de ${agent.alias} está vencido: Cauce encola el mensaje igual y se lo entrega cuando el agente vuelva a reclamar.`
      : `El servidor no informa el lease de ${agent.alias} (sin dato, que no es lo mismo que vencido): Cauce encola el mensaje igual.`;
  // The ITEM is selected, not the delivery: room, lane, actor and trace live on the message.
  const selectedInWindow = hilo.find((item) => mensajeElegido != null && item.message.message_id === mensajeElegido);
  useEffect(() => {
    // Keeps the last observed delivery when polling moves the message out of the window.
    if (selectedInWindow) setSelectedSnapshot(selectedInWindow);
  }, [selectedInWindow]);
  const elegidoPorElOperador = selectedInWindow ?? selectedSnapshot;
  const itemSeleccionado = elegidoPorElOperador ?? hilo.at(-1);
  const totalVisible = (page?.items ?? []).length;

  const mensajePropio = (item: TranscriptItem | undefined) => Boolean(
    replySubject && item?.message.author?.kind === 'human' && item.message.author.subject_id === replySubject,
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
    : rootFromReceipt ?? (latestOwnRoot ? {
        messageId: latestOwnRoot.message.message_id ?? '',
        deliveryId: latestOwnRoot.delivery?.delivery_id ?? '',
        status: latestOwnRoot.delivery?.status,
      } : undefined);
  const canonical = useCanonicalReply({ publisherSubject: replySubject, tenantId: agent.tenantId, alias: agent.alias, root: candidateRoot });

  /*
   * One scroll box wraps the thread and nothing else, so "go to the end" has one destination. It
   * opens at the end and follows new messages only while the operator is watching the end.
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
  const typingKey = `${String(live?.state)}:${String(hilo.at(-1)?.delivery?.status)}`;
  useEffect(() => {
    if (contextOpen) return;
    const caja = cajaRef.current;
    if (!caja) return;
    if (!pegadoRef.current) { caja.scrollTop = scrollPosition.current; return; }
    irAlFinal(caja, false);
    setVistosHastaAqui(hilo.length);
  }, [canonical.reply?.chainOpen, canonical.reply?.messageId, canonical.reply?.reply, contextOpen, ultimoId, hilo.length, typingKey]);

  const contenidoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Late content (media, a reply, a notice) must not leave a reader who was at the end above it.
    const caja = cajaRef.current;
    const contenido = contenidoRef.current;
    if (!caja || !contenido || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (pegadoRef.current) irAlFinal(caja, false); });
    observer.observe(contenido);
    return () => { observer.disconnect(); };
  }, [contextOpen]);

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

  /** The 240-character cut is the server's; the whole body is requested on demand. */
  const pedirCuerpo = useCallback(async (messageId: string) => {
    setCuerpos((previo) => ({ ...previo, [messageId]: { estado: 'pidiendo' } }));
    try {
      const detalle = await api.getMessage(messageId);
      const texto = textoDelCuerpo(detalle.body);
      setCuerpos((previo) => ({
        ...previo,
        [messageId]: texto === undefined ? { estado: 'fallo', motivo: 'El servidor devolvió el mensaje sin cuerpo.' } : { estado: 'listo', texto },
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
    const snapshotText = draft;
    const texto = draft.trim();
    const snapshotFiles = [...archivos];
    if (!puedeEnviar || (!texto && snapshotFiles.length === 0) || enviando || submissions.current.has(draftKey)) return;
    submissions.current.add(draftKey);
    setConfirmandoPublicacion(false);
    updateForm((current) => ({ ...current, sending: true, notice: undefined }));
    const stillActive = () => activePublishScope.current === publishScope;
    const refresh = () => { if (stillActive()) onReload(); };
    try {
      const attachments = await snapshotAttachments(snapshotFiles);
      if (!stillActive()) return;
      const semantics = {
        room_id: roomOrigen,
        recipients: [{ tenant_id: agent.tenantId, alias: agent.alias }],
        body: { text: texto, ...(attachments.length ? { attachments_v1: attachments } : {}) },
        lane,
        // The per-lane priority the publish form always used: interactive 10, batch 0.
        priority: lane === 'interactive' ? 10 : 0,
      } satisfies Omit<Parameters<typeof api.publishMessage>[0], 'idempotency_key'>;
      const { receipt: resultado, reconciled, journalStatus } = await publishDurably({
        api,
        input: semantics,
        publisherSubject,
        expectedDeliveries: 1,
        reconcile: refresh,
        onAccepted: ({ receipt }) => {
          setConfirmandoPublicacion(true);
          updateForm((current) => ({
            ...current,
            text: current.text === snapshotText ? '' : current.text,
            files: current.files.length === snapshotFiles.length
              && snapshotFiles.every((file, index) => current.files[index] === file) ? [] : current.files,
            notice: { tone: 'success', text: `Aceptado por el control plane · ${compactId(receipt.message_id)}. Confirmación pendiente; todavía no hay estado de entrega.` },
          }));
          if (!stillActive()) return;
          setReceiptRoot({ key: replyScopeKey, root: { messageId: receipt.message_id, deliveryId: receipt.delivery_ids[0] } });
          setMensajeElegido(undefined);
          setSelectedSnapshot(undefined);
          pegadoRef.current = true;
          setPegado(true);
          refresh();
        },
      });

      setAviso({
        tone: journalStatus === 'confirmed' ? 'success' : 'parcial',
        text: `${reconciled ? 'Publicación reconciliada desde el journal durable' : 'Aceptado por el control plane'} · ${compactId(resultado.message_id)}. `
          + (journalStatus === 'confirmed'
            ? 'Intención confirmada.'
            : journalStatus === 'pending'
              ? 'Confirmación incierta; intención pendiente y cercada.'
              : 'Confirmación rechazada; intención cercada contra duplicados.'),
      });
    } catch (causa) {
      setAviso({ tone: 'error', text: causa instanceof Error ? causa.message : 'No se pudo publicar el mensaje.' });
    } finally {
      setConfirmandoPublicacion(false);
      submissions.current.delete(draftKey);
      updateForm((current) => ({ ...current, sending: false }));
    }
  }

  function elegir(item: TranscriptItem, opener?: HTMLElement | null) {
    if (!item.message.message_id) return;
    detailTrigger.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMensajeElegido(item.message.message_id);
    setSelectedSnapshot(item);
    setDetalleAbierto(true);
    setDetailFocusRequest((request) => request + 1);
  }

  function closeDetail() {
    setDetalleAbierto(false);
    const trigger = detailTrigger.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else moreTrigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (detalleAbierto) detailHeading.current?.focus({ preventScroll: true });
  }, [detalleAbierto, detailFocusRequest]);

  if (contextOpen) return <AgentSettingsView tenantId={agent.tenantId} alias={agent.alias} conversationPath={conversationPath} />;

  const state = liveStateOf(agent, live);
  const seed = `${agent.tenantId}/${agent.alias}`;
  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-surface" data-objeto-principal="hilo" aria-label={`Conversación con ${agent.alias}`}>
      <ChatHeader agent={agent} state={state} reason={live?.reason} salud={salud} lane={lane} sending={enviando} loading={loading}
        roomId={roomOrigen} totalVisible={totalVisible} receipt={aviso?.tone === 'success' ? aviso.text : undefined}
        moreTriggerRef={moreTrigger} onReload={onReload}
        onLaneChange={(next) => { updateForm((current) => ({ ...current, lane: next })); }} />

      <ConversationNotices health={salud} queueError={queueError} feedError={page ? error : undefined}
        leaseWarning={avisoDeLease} leaseExpired={agent.leaseState === 'expired'}
        topologyWarning={fueraDeLaTopologia(agent) ? motivoDeAgenteSuelto(agent) : undefined}
        onQueueReload={onQueueReload} fallbackFocusRef={moreTrigger} />

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={cajaRef} onScroll={alDesplazar} data-thread-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div ref={contenidoRef} className="mx-auto w-full max-w-3xl px-4 pt-6 pb-6 min-[761px]:px-6">
              {totalVisible >= LIMITE_MENSAJES ? (
                <p role="note" data-truncated className="m-0 mb-4 rounded-lg bg-subtle px-3 py-2 text-center text-xs text-muted">
                  Ventana llena: el servidor devuelve como máximo {LIMITE_MENSAJES} mensajes de toda la flota y este hilo se filtra sobre ellos. Puede haber historia anterior que no entra.
                </p>
              ) : null}
              {error && !page ? (
                <div role="alert"><EmptyState>No se pudo leer el feed de mensajes: {error.message}</EmptyState></div>
              ) : loading && !page ? (
                <LoadingState label="Abriendo la conversación…" />
              ) : (
                <ChatThread
                  key={agent.id}
                  items={hilo}
                  ownSubject={replySubject}
                  alias={agent.alias}
                  seed={seed}
                  agentState={state}
                  selectedMessageId={elegidoPorElOperador?.message.message_id ?? undefined}
                  fullBodies={cuerpos}
                  onSelectItem={elegir}
                  onExpand={(messageId) => { void pedirCuerpo(messageId); }}
                  canonicalReply={canonical.reply}
                  canonicalReplyStale={canonical.stale}
                  onCanonicalReplyRetry={canonical.retry}
                  onSuggestion={puedeEnviar ? (text) => { setDraft(text); composerInput.current?.focus(); } : undefined}
                />
              )}
              {canonical.error ? (
                <p role="status" className="m-0 mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {canonical.accessDenied ? 'La respuesta canónica ya no está disponible para esta identidad o destinatario.'
                    : canonical.stale ? 'No se pudo actualizar la respuesta canónica; se conserva el último dato como desactualizado.'
                      : 'No se pudo leer la respuesta canónica.'}
                  <Button size="sm" onClick={canonical.retry}>Releer respuesta</Button>
                </p>
              ) : null}
            </div>
          </div>

          <div className="relative">
            {!pegado && hilo.length > 0 ? (
              <button type="button" onClick={() => { alFinal(true); }}
                aria-label={nuevosSinVer > 0 ? `Ir al último · ${String(nuevosSinVer)} nuevo${nuevosSinVer === 1 ? '' : 's'}` : 'Ir al último'}
                className="absolute bottom-full left-1/2 z-10 mb-1 flex h-9 min-w-9 -translate-x-1/2 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-fg-2 shadow-pop hover:text-fg">
                <ArrowDown size={15} aria-hidden="true" />
                {nuevosSinVer > 0 ? `${String(nuevosSinVer)} nuevo${nuevosSinVer === 1 ? '' : 's'}` : null}
              </button>
            ) : null}
            <ChatAttachmentsComposer
              agentId={agent.id} agentAlias={agent.alias} canPublish={canPublish} route={route}
              roomChoiceRequired={needsRoomChoice} roomId={roomOrigen} roomUnavailable={roomUnavailable}
              lane={lane} text={draft} files={archivos} sending={enviando} confirming={confirmandoPublicacion}
              notice={aviso} onSubmit={(event) => { void enviar(event); }} onTextChange={setDraft}
              onRoomChange={(roomId) => { updateForm((current) => ({ ...current, roomId })); }}
              onFilesChange={(files) => { updateForm((current) => ({ ...current, files })); }}
              inputRef={composerInput}
            />
          </div>
        </div>

        {detalleAbierto && itemSeleccionado ? (
          <MessageDetail
            item={itemSeleccionado}
            chosen={Boolean(elegidoPorElOperador)}
            outOfWindow={Boolean(mensajeElegido && !hilo.some((item) => item.message.message_id === mensajeElegido))}
            agentId={agent.id}
            fullBody={itemSeleccionado.message.message_id ? cuerpos[itemSeleccionado.message.message_id] : undefined}
            headingRef={detailHeading}
            onFetchBody={(messageId) => { void pedirCuerpo(messageId); }}
            onClose={closeDetail}
          />
        ) : null}
      </div>
    </section>
  );
}

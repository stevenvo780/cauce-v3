import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import {
  Activity,
  Braces,
  ChevronDown,
  CircleOff,
  Clock3,
  LockKeyhole,
  MessageSquareText,
  MonitorPlay,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConsoleAccess, TerminalCapability, TopologySnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, permissionState } from '../../lib';
import { publishDurably } from '../messages/durable-publish';
import { exactCancelReceipt, exactReplayReceipt } from '../queues/delivery-receipts';
import { AckInspector } from './AckInspector';
import {
  TerminalApiError,
  type TerminalSessionGrant,
  type TerminalTargetsSnapshot,
} from './api';
import {
  LEASE_STATE_LABEL,
  LIVE_TUI_LABELS,
  LIVE_TUI_MODE,
  SHELL_MODE,
  TERMINAL_ACCESS_LABELS,
  terminalTargetForAgent,
  type FleetAgent,
} from './fleet';
import {
  explicarDenegacionPty,
  traducirCodigosEnTexto,
  type DenegacionExplicada,
} from './denegaciones';
import { readPtySession, subscribePtySession } from './pty-session';
import { liveTuiGate, terminalChannelGate } from './plugin';
import {
  liveTuiReason,
  operatorRouteForAgent,
  ptySecondsLeft,
  sessionDeliveries,
  transcriptForSession,
  type OperatorSession,
} from './session';
import { TerminalTranscript } from './TerminalTranscript';
import { NegativaPty, PtySessionDialog } from './PtySessionDialog';
import { PtySessionBar } from './PtySessionBar';
import type { MotivoReconciliacionPlaza } from './PlazasColgadas';
import type { RequestTerminalGrant } from './types';

const PtyTerminal = lazy(() => import('./PtyTerminal'));

/** Geometry declared when asking for the grant; the real size is renegotiated on `ready`. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export function SessionStage({ session, sessionToken, agents, access, topologyAccess, capability, targets, grants, closedChannels, onUpdate, onRequestGrant, onChannelClosed, onReleaseChannel, onReconciliarPlazas }: {
  session: OperatorSession;
  /** Incarnation of this tab. Closing and reopening the same alias produces a different token. */
  sessionToken: number;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true | undefined>;
  onUpdate: (session: OperatorSession) => void;
  /** Workspace-owned fence: survives stage unmounts caused by switching tabs. */
  onRequestGrant: RequestTerminalGrant;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
  /** Un rechazo dejó incierto el estado de plazas: se relee el inventario antes de actuar. */
  onReconciliarPlazas: (motivo: MotivoReconciliacionPlaza) => void;
}) {
  const api = useApi();
  const messages = useResource('terminal-message-feed', () => api.listMessages());
  const [draft, setDraft] = useState('');
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [showPtyDialog, setShowPtyDialog] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<DenegacionExplicada>();
  const [closingChannel, setClosingChannel] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showInspector, setShowInspector] = useState(false);
  /** Panel que ya intentó abrir su TUI sola. Es por panel y no se reintenta. */
  const autoOpenedRef = useRef<string>(undefined);
  /**
   * Synchronous fence for the POST. React state cannot provide this guarantee: auto-open and a
   * click can both enter before `setRequesting(true)` has rendered.
   */
  const requestAttemptRef = useRef<{ sequence: number } | undefined>(undefined);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const currentAgent = agents.find((agent) => agent.id === session.agent.id) ?? session.agent;
  const liveSession = { ...session, agent: currentAgent };
  const grant = grants[liveSession.id] as TerminalSessionGrant | undefined;
  const ptyChannelLive = liveSession.mode === 'pty' && grant !== undefined && !closedChannels[liveSession.id];
  /** El terminal está a la vista y pintando: lo accesorio deja de robarle alto. */
  const mostrandoTui = ptyChannelLive;

  const channelSessionId = grant ? grant.session_id : undefined;
  const subscribeChannel = useCallback(
    (listener: () => void) => channelSessionId ? subscribePtySession(channelSessionId, listener) : () => undefined,
    [channelSessionId],
  );
  const readChannel = useCallback(() => channelSessionId ? readPtySession(channelSessionId) : undefined, [channelSessionId]);
  const channelView = useSyncExternalStore(subscribeChannel, readChannel);

  useEffect(() => {
    if (messages.loading || ptyChannelLive) return;
    const interval = window.setInterval(messages.reload, 2_500);
    return () => { window.clearInterval(interval); };
  }, [messages.loading, messages.reload, ptyChannelLive]);

  useEffect(() => {
    if (!ptyChannelLive || channelView?.state === 'open') return;
    const interval = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [channelView?.state, ptyChannelLive]);

  const transcript = transcriptForSession(messages.data, liveSession);
  const deliveries = sessionDeliveries(transcript);
  const selectedDelivery = deliveries.find((delivery) => (
    selectedDeliveryId != null && delivery.delivery_id === selectedDeliveryId
  )) ?? deliveries.at(-1);

  const selectedMessageId = transcript.find((item) => (
    selectedDelivery?.delivery_id != null && item.delivery?.delivery_id === selectedDelivery.delivery_id
  ))?.message.message_id ?? undefined;
  const canPublish = permissionState(access, 'message.publish') === 'allowed';
  const route = operatorRouteForAgent(topologyAccess, access, liveSession.agent);
  const sourceRoomId = route.sourceRoomIds.includes(liveSession.sourceRoomId)
    ? liveSession.sourceRoomId
    : route.sourceRoomIds[0] ?? '';
  const roomEnabled = route.membership === true && Boolean(sourceRoomId);
  const canRoute = route.allowed && roomEnabled;
  const channel = terminalChannelGate(capability, access, targets, liveSession.agent);
  const channelLabel = channel.status !== 'blocked' ? TERMINAL_ACCESS_LABELS[channel.status] : 'PTY no habilitado';
  const channelTarget = terminalTargetForAgent(targets?.items, liveSession.agent);
  const liveTui = liveTuiGate(capability, access, targets, liveSession.agent);
  const liveTuiLabel = liveTui.status === 'blocked' ? 'TUI no habilitada' : LIVE_TUI_LABELS[liveTui.status];

  const liveTuiDetail = liveTui.reason === channel.reason
    ? 'Sin canal PTY no hay TUI que emitir: el motivo es el mismo del canal, acá arriba.'
    : traducirCodigosEnTexto(liveTui.reason);

  const channelReason = channel.reason
    ? traducirCodigosEnTexto(channel.reason)
    : 'Todavía no se pudo leer si hay canal PTY para este alias.';

  const targetMode = grant ? grant.target.mode : liveSession.channelMode;
  const channelIsLiveTui = targetMode === LIVE_TUI_MODE;

  /** Apertura automática de TUI viva al seleccionar el panel si está disponible. */
  useEffect(() => {
    if (!liveTui.enabled) return;
    if (autoOpenedRef.current === liveSession.id) return;
    if (liveSession.id in grants || liveSession.id in closedChannels) return;
    autoOpenedRef.current = liveSession.id;
    void requestChannel(liveTuiReason(liveSession.agent.alias), LIVE_TUI_MODE);
  }, [closedChannels, grants, liveSession.agent.alias, liveSession.id, liveTui.enabled]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish || !sourceRoomId || !canRoute) return;
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    setNotice(undefined);
    try {
      const input = {
        room_id: sourceRoomId,
        recipients: [{ tenant_id: liveSession.agent.tenantId, alias: liveSession.agent.alias }],
        body: { text },
        lane: 'interactive' as const,
        priority: 10,
      };
      const { receipt: result, reconciled, journalStatus } = await publishDurably({
        api,
        input,
        publisherSubject: access?.subject,
        expectedDeliveries: 1,
        reconcile: messages.reload,
      });
      setDraft('');
      setNotice({
        tone: 'success',
        text: `${reconciled ? 'Publicación reconciliada desde el journal durable' : 'Aceptado por el control plane'} · ${compactId(result.message_id)}. `
          + `${journalStatus === 'confirmed'
            ? 'Intención confirmada'
            : journalStatus === 'pending'
              ? 'Confirmación incierta; intención pendiente y cercada'
              : 'Confirmación rechazada; intención cercada contra duplicados'}; esperando ACK por polling.`,
      });
      void messages.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudo publicar la instrucción.' });
    } finally {
      setSubmitting(false);
    }
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function replay(deliveryId: string) {
    const result = await api.replayDelivery(deliveryId);
    if (!exactReplayReceipt(result, deliveryId)) {
      void messages.reload();
      throw new Error('El gateway no devolvió un recibo durable exacto del replay.');
    }
    void messages.reload();
  }

  async function cancel(deliveryId: string) {
    const result = await api.cancelDelivery(deliveryId);
    if (!exactCancelReceipt(result, deliveryId)) {
      void messages.reload();
      throw new Error('El gateway no devolvió un recibo durable exacto de la cancelación.');
    }
    void messages.reload();
  }

  async function requestChannel(reason: string, mode: string) {
    if (mode === LIVE_TUI_MODE ? !liveTui.enabled : !channel.enabled) return;
    if (requestAttemptRef.current !== undefined) return;
    const attempt = { sequence: ++requestSequenceRef.current };
    requestAttemptRef.current = attempt;
    const ownsAttempt = () => mountedRef.current && requestAttemptRef.current === attempt;
    setRequesting(true);
    setRequestError(undefined);
    try {
      const current = grants[liveSession.id] as TerminalSessionGrant | undefined;
      if (current !== undefined && (current.target.mode !== mode || closedChannels[liveSession.id])) {
        await onReleaseChannel(liveSession.id);
      }
      if (!ownsAttempt()) return;
      const outcome = await onRequestGrant(liveSession.id, sessionToken, {
        tenant_id: liveSession.agent.tenantId,
        alias: liveSession.agent.alias,
        mode,
        reason,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      if (!ownsAttempt() || !outcome.adopted) return;
      setShowPtyDialog(false);
    } catch (error) {
      if (!ownsAttempt()) return;
      const explicada = explicarDenegacionPty({
        texto: error instanceof Error ? error.message : undefined,
        estado: error instanceof TerminalApiError ? error.status : undefined,
        codigo: error instanceof TerminalApiError ? error.code : undefined,
      });
      setRequestError(explicada);
      if (explicada.codigo === 'session_limit') {
        onReconciliarPlazas('session_limit');
      } else if (error instanceof TerminalApiError && error.code === 'invalid_grant_receipt') {
        onReconciliarPlazas('invalid_grant_receipt');
      }
      if (mode === LIVE_TUI_MODE) onUpdate({ ...liveSession, liveTuiAttempted: true });
    } finally {
      if (requestAttemptRef.current === attempt) requestAttemptRef.current = undefined;
      if (mountedRef.current) setRequesting(false);
    }
  }

  function openLiveTui() {
    if (!liveTui.enabled) return;
    if (grant !== undefined && !closedChannels[liveSession.id] && grant.target.mode === LIVE_TUI_MODE) {
      onUpdate({ ...liveSession, mode: 'pty' });
      return;
    }
    setRequestError(undefined);
    void requestChannel(liveTuiReason(liveSession.agent.alias), LIVE_TUI_MODE);
  }

  async function releaseChannel() {
    setClosingChannel(true);
    try {
      await onReleaseChannel(liveSession.id);
      onUpdate({ ...liveSession, mode: 'transcript' });
    } finally {
      setClosingChannel(false);
    }
  }

  function selectPtyMode() {
    if (!channel.enabled) return;
    const current = grants[liveSession.id] as TerminalSessionGrant | undefined;
    if (current !== undefined && !closedChannels[liveSession.id] && current.target.mode !== LIVE_TUI_MODE) {
      onUpdate({ ...liveSession, mode: 'pty' });
    } else {
      setRequestError(undefined);
      setShowPtyDialog(true);
    }
  }

  return (
    <div className="terminal-active-grid" id={`terminal-session-${liveSession.id}`} role="tabpanel" data-show-inspector={showInspector} style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <section className="terminal-console">
        <header className="terminal-session-head">
          <div className="session-identity">
            <span className={`session-avatar ${liveSession.agent.leaseState}`}><Braces size={20} aria-hidden="true" /></span>
            <div className="session-identity-text"><p className="eyebrow">{liveSession.agent.tenantId} · epoch <Unknown value={liveSession.agent.presence?.epoch} /></p><h2>{liveSession.agent.alias}</h2></div>
            <Badge tone={liveSession.agent.leaseState === 'online' ? 'online' : liveSession.agent.leaseState === 'expired' ? 'offline' : 'unknown'}>{LEASE_STATE_LABEL[liveSession.agent.leaseState]}</Badge>
          </div>
          <div className="session-controls">
             <label className="terminal-room-label">Room de origen
               <span className="room-select-wrap"><select value={sourceRoomId} onChange={(event) => { onUpdate({ ...liveSession, sourceRoomId: event.target.value }); }} disabled={!route.sourceRoomIds.length}>
                 {route.sourceRoomIds.length ? route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>) : <option value="">No autorizado</option>}
               </select><ChevronDown size={14} aria-hidden="true" /></span>
             </label>
             <div className="terminal-mode-switch" aria-label="Canal de sesión">
               <button type="button" aria-pressed={liveSession.mode === 'transcript'} data-active={liveSession.mode === 'transcript' || undefined} onClick={() => { onUpdate({ ...liveSession, mode: 'transcript' }); }}><MessageSquareText size={14} aria-hidden="true" /> Feed</button>
               <button
                 type="button"
                 aria-pressed={liveSession.mode === 'pty' && channelIsLiveTui}
                 data-active={(liveSession.mode === 'pty' && channelIsLiveTui) || undefined}
                 disabled={!liveTui.enabled || requesting}
                 onClick={openLiveTui}
                 title={traducirCodigosEnTexto(liveTui.reason)}
               ><MonitorPlay size={14} aria-hidden="true" /> TUI</button>
               <button
                 type="button"
                 aria-pressed={liveSession.mode === 'pty' && !channelIsLiveTui}
                 data-active={(liveSession.mode === 'pty' && !channelIsLiveTui) || undefined}
                 disabled={!channel.enabled || requesting}
                 onClick={selectPtyMode}
                 title={channelReason}
               ><TerminalSquare size={14} aria-hidden="true" /> PTY</button>
               <button
                 type="button"
                 data-active={showInspector || undefined}
                 onClick={() => { setShowInspector(!showInspector); }}
                 title="Ver detalles / ACK inspector"
               ><Activity size={14} aria-hidden="true" /> Detalles</button>
            </div>
          </div>
        </header>

        {mostrandoTui ? null : (
          <>
            <p className="terminal-channel-state" data-status={channel.status}>
              <ShieldCheck size={13} aria-hidden="true" />
              <strong>{channelLabel}</strong>
              <span>{channelReason}</span>
            </p>

            <p className="terminal-channel-state terminal-live-tui-state" data-status={liveTui.status}>
              <MonitorPlay size={13} aria-hidden="true" />
              <strong>{liveTuiLabel}</strong>
              <span>{liveTuiDetail}</span>
            </p>
          </>
        )}

        {requestError ? (
          <div className="terminal-channel-refusal">
            <NegativaPty negativa={requestError} />
            <button type="button" className="button small secondary" onClick={() => { setRequestError(undefined); }}>Descartar</button>
          </div>
        ) : null}

        {mostrandoTui ? null : (
          <div className="terminal-connection-bar" role="status">
            <span className={`connection-dot ${messages.error ? 'error' : messages.data ? 'open' : 'connecting'}`} aria-hidden="true" />
            <strong>{messages.error ? 'FEED DEGRADADO' : messages.data ? 'POLLING ACTIVO' : 'CONECTANDO'}</strong>
            <span>{messages.error?.message ?? 'deliveries + ACK cada 2.5 s'}</span>
            <button type="button" onClick={messages.reload} disabled={messages.loading}><RefreshCw size={13} aria-hidden="true" /> Sincronizar</button>
          </div>
        )}

        {liveSession.mode === 'pty' ? (
           channel.enabled && grant && channel.websocketPath ? (
             <div className="terminal-pty-pane">
               <PtySessionBar
                 agent={liveSession.agent}
                 grant={grant}
                 secondsLeft={ptySecondsLeft(grant.expires_at, now)}
                 readOnly={channelIsLiveTui}
                 ticketConsumed={channelView?.state === 'open'}
                 closing={closingChannel}
                 onClose={() => void releaseChannel()}
               />
               <Suspense fallback={<LoadingState label="Cargando Xterm…" />}>
                 <PtyTerminal
                   websocketPath={grant.websocket_path || channel.websocketPath}
                   sessionId={grant.session_id}
                   ticket={grant.ticket}
                   readOnly={channelIsLiveTui}
                   onClosed={() => { onChannelClosed(liveSession.id); }}
                   onRequestNewSession={() => { void onReleaseChannel(liveSession.id).then(() => { setRequestError(undefined); setShowPtyDialog(true); }); }}
                 />
               </Suspense>
            </div>
          ) : <div className="terminal-channel-unavailable"><CircleOff aria-hidden="true" /><h3>{channelLabel}</h3><p>{channelReason}</p></div>
        ) : (
          <>
            {messages.loading && !messages.data ? <LoadingState label="Abriendo feed durable de mensajes…" /> : (
               <TerminalTranscript
                 key={liveSession.id}
                 items={transcript}
                 selectedMessageId={selectedMessageId}
                 onSelectItem={(item) => {
                   if (item.delivery?.delivery_id) {
                     setSelectedDeliveryId(item.delivery.delivery_id);
                   }
                 }}
              />
            )}
            <form className="terminal-composer" onSubmit={(event) => void submit(event)}>
              <label htmlFor={`terminal-input-${liveSession.id}`}>Entrada para {liveSession.agent.alias}</label>
              <textarea
                id={`terminal-input-${liveSession.id}`}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); }}
                onKeyDown={composerKeyDown}
                rows={3}
                maxLength={8_000}
                placeholder={liveSession.agent.leaseState === 'online' ? 'Escribí una instrucción…' : 'El agente no tiene lease vigente; Cauce puede encolar la instrucción.'}
                disabled={!canPublish || !sourceRoomId || !canRoute || submitting}
              />
              <div className="composer-footer">
                <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
                 <button className="button primary" type="submit" disabled={!canPublish || !sourceRoomId || !canRoute || submitting || !(draft.trim())}>
                  <Send size={15} aria-hidden="true" /> {submitting ? 'Enviando…' : 'Enviar'}
                </button>
              </div>
               {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere message.publish.</p> : null}
               {route.membership === undefined ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> No se pudo leer si sos miembro del room de origen; no se asume que lo seas.</p> : null}
               {route.membership === false ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> Membership deshabilitada o sin room compartido.</p> : null}
               {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
              {notice ? <p className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
            </form>
          </>
        )}
      </section>
      <aside className="terminal-inspector" aria-label="Inspector de sesión">
        <AckInspector delivery={selectedDelivery} access={access} onReplay={replay} onCancel={cancel} />
        <section className="terminal-inspector-section session-facts">
          <header className="inspector-title"><div><p className="eyebrow">Session facts</p><h3>Observación</h3></div><Activity size={18} aria-hidden="true" /></header>
          <dl>
            <div><dt>Abierta en UI</dt><dd><Time value={liveSession.openedAt} /></dd></div>
            <div><dt>Lease vence</dt><dd><Time value={liveSession.agent.presence?.lease_expires_at ?? liveSession.agent.presence?.lease_until} /></dd></div>
            <div><dt>Instance</dt><dd className="mono"><Unknown value={liveSession.agent.presence?.instance_id} /></dd></div>
            <div><dt>Historial</dt><dd>{transcript.length} items del servidor</dd></div>
          </dl>
          <p className="inspector-footnote"><Clock3 size={13} aria-hidden="true" /> La pestaña no es una sesión durable ni fuente de verdad.</p>
        </section>
      </aside>

      {showPtyDialog ? (
        <PtySessionDialog
          agent={liveSession.agent}
          resolution={{ status: channel.status === 'blocked' ? 'unknown' : channel.status, reason: channel.reason, target: channelTarget }}
          pending={requesting}
          {...(requestError ? { error: requestError } : {})}
          onCancel={() => { setShowPtyDialog(false); }}
          onConfirm={(reason) => void requestChannel(reason, SHELL_MODE)}
        />
      ) : null}
    </div>
  );
}

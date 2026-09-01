import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Activity,
  Braces,
  CircleOff,
  Clock3,
  ExternalLink,
  MessageSquareText,
  MonitorPlay,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, LoadingState, Time, Unknown } from '../../components/ui';
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

export function SessionStage({ session, sessionToken, agents, access, capability, targets, grants, closedChannels, onUpdate, onRequestGrant, onChannelClosed, onReleaseChannel, onReconciliarPlazas }: {
  session: OperatorSession;
  /** Incarnation of this tab. Closing and reopening the same alias produces a different token. */
  sessionToken: number;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true | undefined>;
  onUpdate: (session: OperatorSession) => void;
  /** Workspace-owned fence: survives stage unmounts caused by switching tabs. */
  onRequestGrant: RequestTerminalGrant;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
  /** A rejection left the seat state uncertain: the inventory is reread before acting. */
  onReconciliarPlazas: (motivo: MotivoReconciliacionPlaza) => void;
}) {
  const api = useApi();
  const messages = useResource('terminal-message-feed', () => api.listMessages());
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string>();
  const [showPtyDialog, setShowPtyDialog] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<DenegacionExplicada>();
  const [closingChannel, setClosingChannel] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showInspector, setShowInspector] = useState(false);
  /** Panel that already tried to open its TUI on its own. It is per panel and is not retried. */
  const autoOpenedRef = useRef<string>(undefined);
  /** Synchronous POST fence: auto-open and a click both enter before `setRequesting` renders. */
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
  /** The terminal is on screen and painting: secondary pieces stop stealing its height. */
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
  const messagesHref = `/messages/${encodeURIComponent(liveSession.agent.tenantId)}/${encodeURIComponent(liveSession.agent.alias)}`;
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

  const requestChannelRef = useRef(requestChannel);
  requestChannelRef.current = requestChannel;

  /** Automatic opening of the live TUI when the panel is selected and it is available. */
  useEffect(() => {
    if (!liveTui.enabled) return;
    if (autoOpenedRef.current === liveSession.id) return;
    // Durable guard: survives the panel remount on a tab switch, which `autoOpenedRef` does not.
    if (liveSession.liveTuiAttempted) return;
    if (liveSession.id in grants || liveSession.id in closedChannels) return;
    autoOpenedRef.current = liveSession.id;
    void requestChannelRef.current(liveTuiReason(liveSession.agent.alias), LIVE_TUI_MODE);
  }, [closedChannels, grants, liveSession.agent.alias, liveSession.id, liveSession.liveTuiAttempted, liveTui.enabled]);

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

  /** Reopens the SAME channel that died: a read-only observation never becomes a writable shell. */
  async function pedirCanalNuevo() {
    const eraTui = channelIsLiveTui;
    await onReleaseChannel(liveSession.id);
    setRequestError(undefined);
    if (eraTui) {
      await requestChannelRef.current(liveTuiReason(liveSession.agent.alias), LIVE_TUI_MODE);
      return;
    }
    setShowPtyDialog(true);
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
                 aria-pressed={showInspector}
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
                 ticketConsumed={channelView?.ticketConsumido === true}
                 feedEnPausa={ptyChannelLive}
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
                   onRequestNewSession={() => { void pedirCanalNuevo(); }}
                 />
               </Suspense>
            </div>
          ) : (
            <div className="terminal-channel-unavailable">
              <CircleOff aria-hidden="true" />
              {/* With the gate open and no grant the channel is simply not open: painting the
                  destination state here said "PTY online" over an empty stage. */}
              <h3>{channel.enabled ? 'No hay canal PTY abierto' : channelLabel}</h3>
              <p>{channel.enabled
                ? 'El canal se cerró o todavía no se pidió. Abrí la TUI en vivo o una shell nueva desde los botones de arriba, o volvé al feed.'
                : channelReason}</p>
            </div>
          )
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
            <div className="terminal-readonly-actions">
              <p>Este feed es de observación. La única vista que publica mensajes es Mensajes.</p>
              <a className="button small secondary" href={messagesHref} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} aria-hidden="true" /> Escribir a {liveSession.agent.alias} en Mensajes
              </a>
            </div>
          </>
        )}
      </section>
      <aside className="terminal-inspector" aria-label="Inspector de sesión">
        <AckInspector delivery={selectedDelivery} />
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

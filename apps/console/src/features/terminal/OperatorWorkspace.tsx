import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  ChevronDown,
  CircleOff,
  Clock3,
  Container,
  LockKeyhole,
  MessageSquareText,
  Plus,
  PowerOff,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
  Timer,
  UserCog,
  X,
} from 'lucide-react';
import { useApi } from '../../api/context';
import type { AdapterView, ConsoleAccess, DeliveryView, TerminalCapability, TopologySnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, createId, permissionState } from '../../lib';
import { AckInspector } from './AckInspector';
import { FleetSidebar } from './FleetSidebar';
import {
  createTerminalSession,
  deleteTerminalSession,
  type TerminalSessionGrant,
  type TerminalTargetsSnapshot,
} from './api';
import type { FleetAgent } from './fleet';
import { TERMINAL_ACCESS_LABELS, terminalTargetForAgent, type TerminalTargetResolution } from './fleet';
import { closePtySession, readPtySession, subscribePtySession } from './pty-session';
import { terminalChannelGate } from './plugin';
import {
  formatCountdown,
  operatorRouteForAgent,
  ptyReasonProblem,
  ptySecondsLeft,
  PTY_REASON_MAX_LENGTH,
  sessionDeliveries,
  transcriptForSession,
  type OperatorSession,
} from './session';
import { TerminalTranscript } from './TerminalTranscript';

const PtyTerminal = lazy(() => import('./PtyTerminal'));

/** Geometry declared when asking for the grant; the real size is renegotiated on `ready`. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface OperatorWorkspaceProps {
  agents: FleetAgent[];
  adapters: AdapterView[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  terminalCapability?: TerminalCapability;
  /** Optional: without the server inventory every destination stays UNKNOWN and PTY is closed. */
  terminalTargets?: TerminalTargetsSnapshot;
  fleetLoading: boolean;
  fleetError?: Error;
}

function sessionId(agent: FleetAgent): string {
  return `session:${agent.id}`;
}

function createSession(agent: FleetAgent, sourceRoomId = ''): OperatorSession {
  return {
    id: sessionId(agent),
    agent,
    sourceRoomId,
    openedAt: new Date().toISOString(),
    mode: 'transcript',
  };
}

function PermissionState({ access, permission }: { access?: ConsoleAccess; permission: 'ultimate-terminal.connect' | 'message.publish' | 'delivery.replay' }) {
  const state = permissionState(access, permission);
  return (
    <div className="terminal-permission-row">
      <span className="mono">{permission}</span>
      <Badge tone={state === 'allowed' ? 'online' : state === 'denied' ? 'danger' : 'unknown'}>{state}</Badge>
    </div>
  );
}

function SessionTabs({ sessions, activeId, onActivate, onClose }: {
  sessions: OperatorSession[];
  activeId?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = sessions[(index + direction + sessions.length) % sessions.length];
    onActivate(next.id);
    document.getElementById(`terminal-tab-${next.id}`)?.focus();
  }

  return (
    <div className="terminal-session-tabs" role="tablist" aria-label="Sesiones de agentes">
      {sessions.map((session, index) => (
        <div className="terminal-tab-wrap" key={session.id} data-active={session.id === activeId || undefined}>
          <button
            id={`terminal-tab-${session.id}`}
            type="button"
            role="tab"
            aria-selected={session.id === activeId}
            aria-controls="terminal-active-session"
            tabIndex={session.id === activeId ? 0 : -1}
            onClick={() => onActivate(session.id)}
            onKeyDown={(event) => navigate(event, index)}
          >
            <span className={`tab-live-dot ${session.agent.leaseState}`} aria-hidden="true" />
            <span><strong>{session.agent.alias}</strong><small>{session.agent.tenantId}</small></span>
          </button>
          <button className="terminal-tab-close" type="button" onClick={() => onClose(session.id)} aria-label={`Cerrar sesión ${session.agent.alias}`}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <span className="terminal-tabs-hint"><Plus size={13} aria-hidden="true" /> Elegí un agente para abrir otra sesión</span>
    </div>
  );
}

/**
 * Consent dialog. It exists to make the blast radius impossible to miss: a shell in a shared
 * container is not "the terminal of one alias", it is the home where several agents live.
 * The justification is mandatory and free-form; there is no default and no autocomplete.
 */
function PtySessionDialog({ agent, resolution, pending, error, onCancel, onConfirm }: {
  agent: FleetAgent;
  resolution: TerminalTargetResolution;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const target = resolution.target;
  const problem = ptyReasonProblem(reason);
  const shared = target?.shares_container_with ?? [];

  useEffect(() => { reasonRef.current?.focus(); }, []);

  return (
    <div className="pty-dialog-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
      <div className="pty-dialog" role="dialog" aria-modal="true" aria-labelledby="pty-dialog-title" aria-describedby="pty-dialog-scope">
        <header>
          <p className="eyebrow">Sesión interactiva</p>
          <h2 id="pty-dialog-title">Abrir PTY en {agent.alias}</h2>
        </header>

        <dl className="pty-dialog-facts" id="pty-dialog-scope">
          <div><dt><Container size={13} aria-hidden="true" /> Contenedor</dt><dd className="mono"><Unknown value={target?.container} /></dd></div>
          <div><dt><UserCog size={13} aria-hidden="true" /> Usuario destino</dt><dd className="mono"><Unknown value={target?.runtime_user} /></dd></div>
          <div><dt><TerminalSquare size={13} aria-hidden="true" /> Modo</dt><dd className="mono">{target?.modes[0] ?? 'shell'}</dd></div>
        </dl>

        {shared.length ? (
          <p className="pty-dialog-shared" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              Este contenedor lo comparten <strong>{shared.join(', ')}</strong>. Una shell acá no es “la terminal de {agent.alias}”:
              es acceso al home donde conviven {[agent.alias, ...shared].join(', ')}.
            </span>
          </p>
        ) : (
          <p className="pty-dialog-solo">El servidor no reporta otros agentes en este contenedor.</p>
        )}

        <label className="pty-dialog-reason" htmlFor="pty-dialog-reason">
          Motivo de la sesión (queda en la auditoría)
          <textarea
            id="pty-dialog-reason"
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={PTY_REASON_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder="Escribí por qué necesitás esta shell…"
            aria-describedby="pty-dialog-reason-hint"
          />
        </label>
        <p className="pty-dialog-hint" id="pty-dialog-reason-hint">{problem ?? `Motivo válido · ${reason.trim().length}/${PTY_REASON_MAX_LENGTH}`}</p>

        {error ? <p className="notice error" role="alert">{error}</p> : null}

        <div className="pty-dialog-actions">
          <button className="button secondary" type="button" onClick={onCancel} disabled={pending}>Cancelar</button>
          <button
            className="button primary"
            type="button"
            disabled={Boolean(problem) || pending}
            title={problem}
            onClick={() => onConfirm(reason.trim())}
          >
            <TerminalSquare size={15} aria-hidden="true" /> {pending ? 'Solicitando…' : 'Abrir sesión PTY'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Permanent header over the terminal: who, where, as whom, and how long is left.
 *
 * `expires_at` is the deadline of the single-use TICKET, not of the shell. Once the relay
 * accepts the attach the ticket is spent, so the countdown is replaced by that fact instead of
 * being left frozen at 0:00 over a perfectly healthy session.
 */
function PtySessionBar({ agent, grant, secondsLeft, ticketConsumed, closing, onClose }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  ticketConsumed: boolean;
  closing: boolean;
  onClose: () => void;
}) {
  return (
    <div className="pty-session-bar" aria-label="Sesión PTY activa">
      <span className="pty-bar-alias"><TerminalSquare size={14} aria-hidden="true" /> <strong>{agent.alias}</strong></span>
      <span><Container size={13} aria-hidden="true" /> <span className="mono"><Unknown value={grant.target.container} /></span></span>
      <span><UserCog size={13} aria-hidden="true" /> <span className="mono"><Unknown value={grant.target.runtime_user} /></span></span>
      <span><Braces size={13} aria-hidden="true" /> <span className="mono">{grant.target.mode}</span></span>
      <span className="pty-bar-countdown" data-expiring={!ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10 ? 'true' : undefined}>
        <Timer size={13} aria-hidden="true" />
        {ticketConsumed
          ? <>Ticket consumido · <strong>sesión activa</strong></>
          : <>Ticket vence en <strong>{formatCountdown(secondsLeft)}</strong></>}
      </span>
      <button className="button small secondary pty-bar-close" type="button" onClick={onClose} disabled={closing}>
        <PowerOff size={13} aria-hidden="true" /> {closing ? 'Cerrando…' : 'Cerrar sesión'}
      </button>
    </div>
  );
}

function AdapterInspector({ adapters, access, capability }: { adapters: AdapterView[]; access?: ConsoleAccess; capability?: TerminalCapability }) {
  return (
    <>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Authority</p><h3>Capability gates</h3></div><ShieldCheck size={18} aria-hidden="true" /></header>
        <div className="terminal-permissions">
          <PermissionState access={access} permission="ultimate-terminal.connect" />
          <PermissionState access={access} permission="message.publish" />
          <PermissionState access={access} permission="delivery.replay" />
        </div>
        <p className="inspector-footnote">Roles: {access?.roles?.length ? access.roles.join(', ') : 'UNKNOWN'}. La UI no eleva permisos faltantes.</p>
      </section>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Transport plane</p><h3>Adapters</h3></div><Bot size={18} aria-hidden="true" /></header>
        <div className="terminal-adapter-list">
          {adapters.length ? adapters.map((adapter, index) => (
            <article key={adapter.id ?? index}>
              <span className={`adapter-state-dot ${adapter.state ?? 'unknown'}`} aria-hidden="true" />
              <div><strong><Unknown value={adapter.label ?? adapter.id} /></strong><small>{adapter.capabilities?.length ?? 'UNKNOWN'} capabilities</small></div>
              <Badge tone={adapter.state === 'available' ? 'online' : adapter.state === 'degraded' ? 'warning' : adapter.state === 'unavailable' ? 'offline' : 'unknown'}><Unknown value={adapter.state} /></Badge>
            </article>
          )) : <EmptyState>Adapters no informados.</EmptyState>}
        </div>
      </section>
      <section className="terminal-inspector-section terminal-pty-capability">
        <header className="inspector-title"><div><p className="eyebrow">Optional channel</p><h3>PTY directo</h3></div><TerminalSquare size={18} aria-hidden="true" /></header>
        <dl>
          <div><dt>Estado</dt><dd>{capability?.available === true ? 'Disponible' : capability?.available === false ? 'No disponible' : 'UNKNOWN'}</dd></div>
          <div><dt>Target</dt><dd><Unknown value={capability?.target_label} /></dd></div>
          <div><dt>Endpoint</dt><dd className="mono"><Unknown value={capability?.websocket_path} /></dd></div>
        </dl>
        <p className="inspector-footnote">La autoridad por destino la da el servidor en cada target, no este resumen.</p>
      </section>
    </>
  );
}

function SessionStage({ sessions, activeId, agents, adapters, access, topologyAccess, capability, targets, grants, closedChannels, onActivate, onClose, onUpdate, onGrant, onChannelClosed, onReleaseChannel }: {
  sessions: OperatorSession[];
  activeId?: string;
  agents: FleetAgent[];
  adapters: AdapterView[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onUpdate: (session: OperatorSession) => void;
  onGrant: (sessionId: string, grant: TerminalSessionGrant) => void;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
}) {
  const api = useApi();
  const messages = useResource('terminal-message-feed', () => api.listMessages());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedDeliveries, setSelectedDeliveries] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [dialogFor, setDialogFor] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const [closingChannel, setClosingChannel] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const storedSession = sessions.find((session) => session.id === activeId);
  const currentAgent = storedSession ? agents.find((agent) => agent.id === storedSession.agent.id) ?? storedSession.agent : undefined;
  const session = storedSession && currentAgent ? { ...storedSession, agent: currentAgent } : undefined;
  const grant = session ? grants[session.id] : undefined;
  // An open PTY carries its own live stream: the 2.5 s message polling is redundant there.
  const ptyChannelLive = Boolean(session && session.mode === 'pty' && grant && !closedChannels[session.id]);

  const channelSessionId = grant?.session_id;
  const subscribeChannel = useCallback(
    (listener: () => void) => channelSessionId ? subscribePtySession(channelSessionId, listener) : () => undefined,
    [channelSessionId],
  );
  const readChannel = useCallback(() => channelSessionId ? readPtySession(channelSessionId) : undefined, [channelSessionId]);
  const channelView = useSyncExternalStore(subscribeChannel, readChannel);

  useEffect(() => {
    if (messages.loading || ptyChannelLive) return;
    const interval = window.setInterval(messages.reload, 2_500);
    return () => window.clearInterval(interval);
  }, [messages.loading, messages.reload, ptyChannelLive]);

  useEffect(() => {
    // Only the ticket window needs a clock; once it is spent the countdown has nothing to say.
    if (!ptyChannelLive || channelView?.state === 'open') return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [channelView?.state, ptyChannelLive]);

  const transcript = session ? transcriptForSession(messages.data, session) : [];
  const deliveries = sessionDeliveries(transcript);
  const selectedId = session ? selectedDeliveries[session.id] : undefined;
  const selectedDelivery = deliveries.find((delivery) => delivery.delivery_id === selectedId) ?? deliveries.at(-1);
  const canPublish = permissionState(access, 'message.publish') === 'allowed';
  const route = session ? operatorRouteForAgent(topologyAccess, access, session.agent) : undefined;
  const sourceRoomId = session && route
    ? route.sourceRoomIds.includes(session.sourceRoomId) ? session.sourceRoomId : route.sourceRoomIds[0] ?? ''
    : '';
  const roomEnabled = route?.membership === true && Boolean(sourceRoomId);
  const canRoute = route?.allowed === true && roomEnabled;
  const channel = session ? terminalChannelGate(capability, access, targets, session.agent) : undefined;
  const channelLabel = channel && channel.status !== 'blocked' ? TERMINAL_ACCESS_LABELS[channel.status] : 'PTY no habilitado';
  const channelTarget = session ? terminalTargetForAgent(targets?.items, session.agent) : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !canPublish || !sourceRoomId || !canRoute) return;
    const text = drafts[session.id]?.trim();
    if (!text) return;
    setSubmitting(true);
    setNotice(undefined);
    try {
      const result = await api.publishMessage({
        room_id: sourceRoomId,
        recipients: [{ tenant_id: session.agent.tenantId, alias: session.agent.alias }],
        body: { text },
        lane: 'interactive',
        priority: 10,
        idempotency_key: createId(`ultimate-terminal-${session.agent.alias}`),
      });
      setDrafts((current) => ({ ...current, [session.id]: '' }));
      setNotice({ tone: 'success', text: `Aceptado por el control plane · ${compactId(result.message_id)}. Esperando ACK por polling.` });
      messages.reload();
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
    await api.replayDelivery(deliveryId);
    messages.reload();
  }

  /** Requests the single-use ticket and only then opens the socket. */
  async function requestChannel(reason: string) {
    if (!session || !channel?.enabled) return;
    setRequesting(true);
    setRequestError(undefined);
    try {
      const issued = await createTerminalSession({
        tenant_id: session.agent.tenantId,
        alias: session.agent.alias,
        mode: channelTarget?.modes[0] ?? 'shell',
        reason,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      onGrant(session.id, issued);
      onUpdate({ ...session, mode: 'pty' });
      setDialogFor(undefined);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'El servidor rechazó la sesión PTY.');
    } finally {
      setRequesting(false);
    }
  }

  async function releaseChannel() {
    if (!session) return;
    setClosingChannel(true);
    try {
      await onReleaseChannel(session.id);
      onUpdate({ ...session, mode: 'transcript' });
    } finally {
      setClosingChannel(false);
    }
  }

  function selectPtyMode() {
    if (!session || !channel?.enabled) return;
    // A live grant just re-shows the terminal; a new channel always goes through the dialog.
    if (grants[session.id] && !closedChannels[session.id]) onUpdate({ ...session, mode: 'pty' });
    else { setRequestError(undefined); setDialogFor(session.id); }
  }

  return (
    <div className="terminal-stage">
      <SessionTabs sessions={sessions} activeId={activeId} onActivate={onActivate} onClose={onClose} />
      {!session ? (
        <div className="terminal-no-session">
          <span><MessageSquareText size={27} aria-hidden="true" /></span>
          <p className="eyebrow">No active target</p>
          <h2>Abrí una sesión desde Fleet</h2>
          <p>Cada pestaña es una vista efímera sobre mensajes y ACK del servidor. No se persiste estado de sesión en el navegador.</p>
        </div>
      ) : (
        <div className="terminal-active-grid" id="terminal-active-session" role="tabpanel" aria-labelledby={`terminal-tab-${session.id}`}>
          <section className="terminal-console">
            <header className="terminal-session-head">
              <div className="session-identity">
                <span className={`session-avatar ${session.agent.leaseState}`}><Braces size={20} aria-hidden="true" /></span>
                <div><p className="eyebrow">{session.agent.tenantId} · epoch {session.agent.presence?.epoch ?? 'UNKNOWN'}</p><h2>{session.agent.alias}</h2></div>
                <Badge tone={session.agent.leaseState === 'online' ? 'online' : session.agent.leaseState === 'expired' ? 'offline' : 'unknown'}>{session.agent.leaseState}</Badge>
              </div>
              <div className="session-controls">
                 <label>Room de origen
                   <span className="room-select-wrap"><select value={sourceRoomId} onChange={(event) => onUpdate({ ...session, sourceRoomId: event.target.value })} disabled={!route?.sourceRoomIds.length}>
                     {route?.sourceRoomIds.length ? route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>) : <option value="">No autorizado</option>}
                   </select><ChevronDown size={14} aria-hidden="true" /></span>
                 </label>
                 <div className="terminal-mode-switch" aria-label="Canal de sesión">
                   <button type="button" aria-pressed={session.mode === 'transcript'} data-active={session.mode === 'transcript' || undefined} onClick={() => onUpdate({ ...session, mode: 'transcript' })}><MessageSquareText size={14} aria-hidden="true" /> Feed</button>
                   <button
                     type="button"
                     aria-pressed={session.mode === 'pty'}
                     data-active={session.mode === 'pty' || undefined}
                     disabled={!channel?.enabled}
                     onClick={selectPtyMode}
                     title={channel?.reason}
                   ><TerminalSquare size={14} aria-hidden="true" /> PTY</button>
                </div>
              </div>
            </header>

            <p className="terminal-channel-state" data-status={channel?.status ?? 'blocked'}>
              <ShieldCheck size={13} aria-hidden="true" />
              <strong>{channelLabel}</strong>
              <span>{channel?.reason ?? 'Canal PTY UNKNOWN.'}</span>
            </p>

            <div className="terminal-connection-bar" role="status">
              <span className={`connection-dot ${messages.error ? 'error' : ptyChannelLive ? 'open' : messages.data ? 'open' : 'connecting'}`} aria-hidden="true" />
              <strong>{messages.error ? 'FEED DEGRADADO' : ptyChannelLive ? 'POLLING EN PAUSA' : messages.data ? 'POLLING ACTIVO' : 'CONECTANDO'}</strong>
              <span>{messages.error?.message ?? (ptyChannelLive ? 'el canal PTY es la fuente en vivo de esta sesión' : 'deliveries + ACK cada 2.5 s')}</span>
              <button type="button" onClick={messages.reload} disabled={messages.loading}><RefreshCw size={13} aria-hidden="true" /> Sincronizar</button>
            </div>

            {session.mode === 'pty' ? (
               channel?.enabled && grant && channel.websocketPath ? (
                 <div className="terminal-pty-pane">
                   <PtySessionBar
                     agent={session.agent}
                     grant={grant}
                     secondsLeft={ptySecondsLeft(grant.expires_at, now)}
                     ticketConsumed={channelView?.state === 'open'}
                     closing={closingChannel}
                     onClose={() => void releaseChannel()}
                   />
                   <Suspense fallback={<LoadingState label="Cargando Xterm…" />}>
                     <PtyTerminal
                       websocketPath={grant.websocket_path || channel.websocketPath}
                       sessionId={grant.session_id}
                       ticket={grant.ticket}
                       onClosed={() => onChannelClosed(session.id)}
                       onRequestNewSession={() => { void onReleaseChannel(session.id).then(() => { setRequestError(undefined); setDialogFor(session.id); }); }}
                     />
                   </Suspense>
                </div>
              ) : <div className="terminal-channel-unavailable"><CircleOff aria-hidden="true" /><h3>{channelLabel}</h3><p>{channel?.reason ?? 'Canal PTY UNKNOWN.'}</p></div>
            ) : (
              <>
                {messages.loading && !messages.data ? <LoadingState label="Abriendo feed durable de mensajes…" /> : (
                   <TerminalTranscript
                     key={session.id}
                     items={transcript}
                    selectedDeliveryId={selectedDelivery?.delivery_id ?? undefined}
                    onSelectDelivery={(delivery: DeliveryView) => delivery.delivery_id && setSelectedDeliveries((current) => ({ ...current, [session.id]: delivery.delivery_id! }))}
                  />
                )}
                <form className="terminal-composer" onSubmit={(event) => void submit(event)}>
                  <label htmlFor={`terminal-input-${session.id}`}>Entrada para {session.agent.alias}</label>
                  <textarea
                    id={`terminal-input-${session.id}`}
                    value={drafts[session.id] ?? ''}
                    onChange={(event) => setDrafts((current) => ({ ...current, [session.id]: event.target.value }))}
                    onKeyDown={composerKeyDown}
                    rows={3}
                    maxLength={8_000}
                    placeholder={session.agent.leaseState === 'online' ? 'Escribí una instrucción…' : 'El agente no tiene lease vigente; Cauce puede encolar la instrucción.'}
                     disabled={!canPublish || !sourceRoomId || !canRoute || submitting}
                  />
                  <div className="composer-footer">
                    <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
                     <button className="button primary" type="submit" disabled={!canPublish || !sourceRoomId || !canRoute || submitting || !(drafts[session.id]?.trim())}>
                      <Send size={15} aria-hidden="true" /> {submitting ? 'Enviando…' : 'Enviar'}
                    </button>
                  </div>
                   {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere message.publish.</p> : null}
                   {route?.membership === undefined ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> Membership UNKNOWN; no se asume acceso al room de origen.</p> : null}
                   {route?.membership === false ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> Membership deshabilitada o sin room compartido.</p> : null}
                   {route && !route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
                  {notice ? <p className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
                </form>
              </>
            )}
          </section>
          <aside className="terminal-inspector" aria-label="Inspector de sesión">
            <AckInspector delivery={selectedDelivery} access={access} onReplay={replay} />
            <section className="terminal-inspector-section session-facts">
              <header className="inspector-title"><div><p className="eyebrow">Session facts</p><h3>Observación</h3></div><Activity size={18} aria-hidden="true" /></header>
              <dl>
                <div><dt>Abierta en UI</dt><dd><Time value={session.openedAt} /></dd></div>
                <div><dt>Lease vence</dt><dd><Time value={session.agent.presence?.lease_expires_at ?? session.agent.presence?.lease_until} /></dd></div>
                <div><dt>Instance</dt><dd className="mono"><Unknown value={session.agent.presence?.instance_id} /></dd></div>
                <div><dt>Historial</dt><dd>{transcript.length} items del servidor</dd></div>
              </dl>
              <p className="inspector-footnote"><Clock3 size={13} aria-hidden="true" /> La pestaña no es una sesión durable ni fuente de verdad.</p>
            </section>
          </aside>
        </div>
      )}
      <footer className="terminal-doctrine"><ShieldCheck size={14} aria-hidden="true" /> Cliente de transporte: no crea workers remotos, no ejecuta adapters y no persiste sesiones.</footer>
      <div className="terminal-adapter-mobile"><AdapterInspector adapters={adapters} access={access} capability={capability} /></div>
      {session && dialogFor === session.id && channel?.enabled ? (
        <PtySessionDialog
          agent={session.agent}
          resolution={{ status: channel.status === 'blocked' ? 'unknown' : channel.status, reason: channel.reason, target: channelTarget }}
          pending={requesting}
          error={requestError}
          onCancel={() => setDialogFor(undefined)}
          onConfirm={(reason) => void requestChannel(reason)}
        />
      ) : null}
    </div>
  );
}

export function OperatorWorkspace({ agents, adapters, access, topologyAccess, terminalCapability, terminalTargets, fleetLoading, fleetError }: OperatorWorkspaceProps) {
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  // Tickets and grants live in memory only, keyed by UI session; never persisted.
  const [grants, setGrants] = useState<Record<string, TerminalSessionGrant>>({});
  const [closedChannels, setClosedChannels] = useState<Record<string, true>>({});
  const liveSessions = sessions.map((session) => ({
    ...session,
    agent: agents.find((agent) => agent.id === session.agent.id) ?? session.agent,
  }));
  const activeSession = liveSessions.find((session) => session.id === activeId);

  function openAgent(agent: FleetAgent) {
    const id = sessionId(agent);
    const sourceRoomId = operatorRouteForAgent(topologyAccess, access, agent).sourceRoomIds[0] ?? '';
    setSessions((current) => {
      const existing = current.find((session) => session.id === id);
      if (!existing) return [...current, createSession(agent, sourceRoomId)];
      if (!sourceRoomId || existing.sourceRoomId === sourceRoomId) return current;
      return current.map((session) => session.id === id ? { ...session, sourceRoomId } : session);
    });
    setActiveId(id);
  }

  /** Releases the grant server-side (DELETE) and then tears the local terminal down. */
  async function releaseChannel(id: string) {
    const grant = grants[id];
    if (!grant) return;
    try {
      await deleteTerminalSession(grant.session_id);
    } catch {
      // The socket still has to go: a client-side failure must not leave a shell attached here.
    } finally {
      closePtySession(grant.session_id);
      setGrants((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setClosedChannels((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  function closeSession(id: string) {
    const index = sessions.findIndex((session) => session.id === id);
    const next = sessions.filter((session) => session.id !== id);
    void releaseChannel(id);
    setSessions(next);
    if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id);
  }

  function updateSession(updated: OperatorSession) {
    setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
  }

  return (
    <div className="ultimate-terminal-shell">
      <FleetSidebar
        agents={agents}
        adapters={adapters}
        activeAgentId={activeSession?.agent.id}
        onOpenAgent={openAgent}
        loading={fleetLoading}
        error={fleetError}
        targets={terminalTargets}
      />
      <SessionStage
        sessions={liveSessions}
        activeId={activeId}
        agents={agents}
        adapters={adapters}
        access={access}
        topologyAccess={topologyAccess}
        capability={terminalCapability}
        targets={terminalTargets}
        grants={grants}
        closedChannels={closedChannels}
        onActivate={setActiveId}
        onClose={closeSession}
        onUpdate={updateSession}
        onGrant={(id, grant) => setGrants((current) => ({ ...current, [id]: grant }))}
        onChannelClosed={(id) => setClosedChannels((current) => ({ ...current, [id]: true }))}
        onReleaseChannel={releaseChannel}
      />
      <aside className="terminal-control-inspector" aria-label="Estado del control plane">
        <AdapterInspector adapters={adapters} access={access} capability={terminalCapability} />
      </aside>
    </div>
  );
}

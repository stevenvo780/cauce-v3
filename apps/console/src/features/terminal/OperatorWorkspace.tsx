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
  KeyRound,
  LockKeyhole,
  Eye,
  MessageSquareText,
  MonitorPlay,
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
  TerminalApiError,
  createTerminalSession,
  deleteTerminalSession,
  type TerminalSessionGrant,
  type TerminalTargetsSnapshot,
} from './api';
import type { FleetAgent } from './fleet';
import {
  LEASE_STATE_LABEL,
  LIVE_TUI_LABELS,
  LIVE_TUI_MODE,
  SHELL_MODE,
  TERMINAL_ACCESS_LABELS,
  terminalTargetForAgent,
  type TerminalTargetResolution,
} from './fleet';
import { explicarDenegacionPty, traducirCodigosEnTexto, type DenegacionExplicada } from './denegaciones';
import { closePtySession, readPtySession, subscribePtySession } from './pty-session';
import { liveTuiGate, terminalChannelGate } from './plugin';
import {
  formatCountdown,
  liveTuiReason,
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

/**
 * Estado del adaptador, en castellano.
 *
 * 🔴 Acá vivía el defecto más tonto y más visible de la vista: el componente `<Unknown>` estaba
 * ESCAPADO en el JSX (`&lt;Unknown value=… /&gt;`), así que el DOM de `/terminal` decía, textual,
 * «<UNKNOWN VALUE=AVAILABLE />» en cada tarjeta de adaptador. Cuatro veces, medido en el navegador.
 * Los 646 tests pasaban con eso en pantalla porque nadie compara el TEXTO de ese badge.
 *
 * De paso deja de ser una palabra en inglés en mayúsculas: `available` no es un estado, es un
 * campo de la API.
 */
const ADAPTER_STATE_LABEL: Readonly<Record<string, string>> = {
  available: 'Disponible',
  degraded: 'Degradado',
  unavailable: 'No disponible',
  unknown: 'Sin dato',
};

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

/**
 * **La negativa, dicha entera.**
 *
 * Antes acá se pintaba `{error}` a secas, y ese `error` era el `reason` crudo del gateway: el
 * `[role=alert]` de producción contenía EXACTAMENTE «no_grant». Ahora se pintan las tres cosas que
 * hacen falta para poder hacer algo al respecto: qué pasó, por qué, y a quién pedírselo.
 *
 * El código crudo NO desaparece —sigue en `data-codigo`, que es lo que se pega en un informe— pero
 * deja de ser lo único que el operador ve.
 */
function NegativaPty({ negativa }: { negativa: DenegacionExplicada }) {
  return (
    <div className="pty-negativa" role="alert" data-codigo={negativa.codigo}>
      <strong>{negativa.titulo}</strong>
      <p>{negativa.porQue}</p>
      {negativa.quienLoLevanta ? <p className="pty-negativa-quien"><KeyRound size={13} aria-hidden="true" /> Lo levanta: {negativa.quienLoLevanta}</p> : null}
    </div>
  );
}

function PtySessionDialog({ agent, resolution, pending, error, onCancel, onConfirm }: {
  agent: FleetAgent;
  resolution: TerminalTargetResolution;
  pending: boolean;
  error?: DenegacionExplicada;
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

        {error ? <NegativaPty negativa={error} /> : null}

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

function PtySessionBar({ agent, grant, secondsLeft, readOnly, ticketConsumed, closing, onClose }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  /** El canal es una observación de la TUI: la consola no manda teclas. */
  readOnly: boolean;
  ticketConsumed: boolean;
  closing: boolean;
  onClose: () => void;
}) {
  return (
    <div className="pty-session-bar" aria-label="Sesión PTY activa" data-read-only={readOnly || undefined}>
      <span className="pty-bar-alias">{readOnly ? <MonitorPlay size={14} aria-hidden="true" /> : <TerminalSquare size={14} aria-hidden="true" />} <strong>{agent.alias}</strong></span>
      {readOnly ? <span className="pty-bar-readonly"><Eye size={13} aria-hidden="true" /> TUI en vivo · solo lectura</span> : null}
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
        <p className="inspector-footnote">Roles: {access?.roles?.length ? access.roles.join(', ') : 'sin dato'}. La UI no eleva permisos faltantes.</p>
      </section>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Transport plane</p><h3>Adapters</h3></div><Bot size={18} aria-hidden="true" /></header>
        <div className="terminal-adapter-list">
          {adapters.length ? adapters.map((adapter, index) => (
            <article key={adapter.id ?? index}>
              <span className={`adapter-state-dot ${adapter.state ?? 'unknown'}`} aria-hidden="true" />
              <div><strong><Unknown value={adapter.label ?? adapter.id} /></strong><small>{adapter.capabilities?.length ?? 'sin dato de'} capacidades</small></div>
              <Badge tone={adapter.state === 'available' ? 'online' : adapter.state === 'degraded' ? 'warning' : adapter.state === 'unavailable' ? 'offline' : 'unknown'}>{ADAPTER_STATE_LABEL[adapter.state ?? 'unknown'] ?? adapter.state}</Badge>
            </article>
          )) : <EmptyState>Adapters no informados.</EmptyState>}
        </div>
      </section>
      <section className="terminal-inspector-section terminal-pty-capability">
        <header className="inspector-title"><div><p className="eyebrow">Optional channel</p><h3>PTY directo</h3></div><TerminalSquare size={18} aria-hidden="true" /></header>
        <dl>
          <div><dt>Estado</dt><dd>{capability?.available === true ? 'Disponible' : capability?.available === false ? 'No disponible' : 'sin dato'}</dd></div>
          <div><dt>Target</dt><dd><Unknown value={capability?.target_label} /></dd></div>
          <div><dt>Endpoint</dt><dd className="mono"><Unknown value={capability?.websocket_path} /></dd></div>
        </dl>
        <p className="inspector-footnote">La autoridad por destino la da el servidor en cada target, no este resumen.</p>
      </section>
    </>
  );
}

function SessionStage({ session, agents, access, topologyAccess, capability, targets, grants, closedChannels, onUpdate, onGrant, onChannelClosed, onReleaseChannel }: {
  session: OperatorSession;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true>;
  onUpdate: (session: OperatorSession) => void;
  onGrant: (sessionId: string, grant: TerminalSessionGrant) => void;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
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

  const currentAgent = agents.find((agent) => agent.id === session.agent.id) ?? session.agent;
  const liveSession = { ...session, agent: currentAgent };
  const grant = grants[liveSession.id];
  const ptyChannelLive = Boolean(liveSession.mode === 'pty' && grant && !closedChannels[liveSession.id]);

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
    if (!ptyChannelLive || channelView?.state === 'open') return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [channelView?.state, ptyChannelLive]);


  const transcript = transcriptForSession(messages.data, liveSession);
  const deliveries = sessionDeliveries(transcript);
  const selectedDelivery = deliveries.find((delivery) => delivery.delivery_id === selectedDeliveryId) ?? deliveries.at(-1);
  const canPublish = permissionState(access, 'message.publish') === 'allowed';
  const route = operatorRouteForAgent(topologyAccess, access, liveSession.agent);
  const sourceRoomId = route.sourceRoomIds.includes(liveSession.sourceRoomId)
    ? liveSession.sourceRoomId
    : route.sourceRoomIds[0] ?? '';
  const roomEnabled = route.membership === true && Boolean(sourceRoomId);
  const canRoute = route.allowed === true && roomEnabled;
  const channel = terminalChannelGate(capability, access, targets, liveSession.agent);
  const channelLabel = channel && channel.status !== 'blocked' ? TERMINAL_ACCESS_LABELS[channel.status] : 'PTY no habilitado';
  const channelTarget = terminalTargetForAgent(targets?.items, liveSession.agent);
  const liveTui = liveTuiGate(capability, access, targets, liveSession.agent);
  const liveTuiLabel = liveTui.status === 'blocked' ? 'TUI no habilitada' : LIVE_TUI_LABELS[liveTui.status];
  // Cuando la TUI cae por el mismo motivo que el canal PTY, no se repite la frase: repetirla
  // hace parecer que son dos hallazgos y ensucia la lectura. Se dice que es el mismo y se apunta.
  const liveTuiDetail = liveTui.reason === channel?.reason
    ? 'Sin canal PTY no hay TUI que emitir: el motivo es el mismo del canal, acá arriba.'
    : traducirCodigosEnTexto(liveTui.reason);
  // El inventario de destinos manda el código DENTRO de la prosa («attribution_required: falta
  // identidad por persona.»), así que la traducción tiene que pasar también por acá y no sólo
  // por el rechazo del POST.
  const channelReason = channel?.reason
    ? traducirCodigosEnTexto(channel.reason)
    : 'Todavía no se pudo leer si hay canal PTY para este alias.';
  // El canal abierto puede ser la TUI (observación) o una shell (escribe). Manda lo que otorgó
  // el servidor en el grant, no lo que la pestaña creía haber pedido.
  const channelIsLiveTui = (grant?.target.mode ?? liveSession.channelMode) === LIVE_TUI_MODE;
  /**
   * La vista por defecto de una pestaña es la TUI viva del agente, no el feed.
   *
   * Steven lo pidió así: abrir la vista, elegir un agente y VER lo que está haciendo ahora —
   * sin elegir modo y sin escribir un motivo. Se intenta UNA sola vez por panel: un 403 o un
   * 409 del gateway no puede convertirse en un bucle de pedidos contra el plano de control.
   * Si el alias no publica `harness`, no se pide nada y la pestaña se queda en el feed con el
   * motivo medido a la vista.
   */
  useEffect(() => {
    if (!liveTui.enabled) return;
    if (autoOpenedRef.current === liveSession.id) return;
    if (grants[liveSession.id] || closedChannels[liveSession.id]) return;
    autoOpenedRef.current = liveSession.id;
    void requestChannel(liveTuiReason(liveSession.agent.alias), LIVE_TUI_MODE);
    // `requestChannel` se recrea en cada render; incluirlo acá volvería a disparar la apertura.
    // La guarda real es `autoOpenedRef`, que es por panel y sobrevive a los renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedChannels, grants, liveSession.agent.alias, liveSession.id, liveTui.enabled]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish || !sourceRoomId || !canRoute) return;
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    setNotice(undefined);
    try {
      const result = await api.publishMessage({
        room_id: sourceRoomId,
        recipients: [{ tenant_id: liveSession.agent.tenantId, alias: liveSession.agent.alias }],
        body: { text },
        lane: 'interactive',
        priority: 10,
        idempotency_key: createId(`ultimate-terminal-${liveSession.agent.alias}`),
      });
      setDraft('');
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

  async function cancel(deliveryId: string) {
    await api.cancelDelivery(deliveryId);
    messages.reload();
  }

  async function requestChannel(reason: string, mode: string) {
    if (mode === LIVE_TUI_MODE ? !liveTui.enabled : !channel?.enabled) return;
    setRequesting(true);
    setRequestError(undefined);
    try {
      // Un grant es de UN modo. Pasar de la TUI a una shell (o al revés) no es cambiar de
      // pestaña: es otra autorización, con su motivo y su fila de auditoría. La sesión anterior
      // se suelta contra el servidor primero, para no dejarla colgada del otro lado.
      const current = grants[liveSession.id];
      if (current && current.target.mode !== mode) await onReleaseChannel(liveSession.id);
      const issued = await createTerminalSession({
        tenant_id: liveSession.agent.tenantId,
        alias: liveSession.agent.alias,
        mode,
        reason,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      onGrant(liveSession.id, issued);
      onUpdate({ ...liveSession, mode: 'pty', channelMode: mode, liveTuiAttempted: true });
      setShowPtyDialog(false);
    } catch (error) {
      // El rechazo se TRADUCE acá, en el único sitio por el que pasan los ocho códigos del
      // gateway. `TerminalApiError` trae el estado HTTP y el `error` del cuerpo; los dos hacían
      // falta y ninguno se estaba mostrando.
      setRequestError(explicarDenegacionPty({
        texto: error instanceof Error ? error.message : undefined,
        estado: error instanceof TerminalApiError ? error.status : undefined,
        codigo: error instanceof TerminalApiError ? error.code : undefined,
      }));
      // Un rechazo se cuenta como intento: la apertura automática no vuelve a golpear al gateway.
      if (mode === LIVE_TUI_MODE) onUpdate({ ...liveSession, liveTuiAttempted: true });
    } finally {
      setRequesting(false);
    }
  }

  /**
   * La TUI se abre de un clic: no hay diálogo de motivo porque no se está abriendo una shell,
   * se está mirando la pantalla que el agente ya tiene pintada. El motivo igual viaja y queda
   * auditado, y dice que fue automático.
   */
  function openLiveTui() {
    if (!liveTui.enabled) return;
    if (grant && !closedChannels[liveSession.id] && grant.target.mode === LIVE_TUI_MODE) {
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
    if (!channel?.enabled) return;
    const current = grants[liveSession.id];
    if (current && !closedChannels[liveSession.id] && current.target.mode !== LIVE_TUI_MODE) {
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
             <label>Room de origen
               <span className="room-select-wrap"><select value={sourceRoomId} onChange={(event) => onUpdate({ ...liveSession, sourceRoomId: event.target.value })} disabled={!route.sourceRoomIds.length}>
                 {route.sourceRoomIds.length ? route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>) : <option value="">No autorizado</option>}
               </select><ChevronDown size={14} aria-hidden="true" /></span>
             </label>
             <div className="terminal-mode-switch" aria-label="Canal de sesión">
               <button type="button" aria-pressed={liveSession.mode === 'transcript'} data-active={liveSession.mode === 'transcript' || undefined} onClick={() => onUpdate({ ...liveSession, mode: 'transcript' })}><MessageSquareText size={14} aria-hidden="true" /> Feed</button>
               <button
                 type="button"
                 aria-pressed={liveSession.mode === 'pty' && channelIsLiveTui}
                 data-active={(liveSession.mode === 'pty' && channelIsLiveTui) || undefined}
                 disabled={!liveTui.enabled}
                 onClick={openLiveTui}
                 title={traducirCodigosEnTexto(liveTui.reason)}
               ><MonitorPlay size={14} aria-hidden="true" /> TUI</button>
               <button
                 type="button"
                 aria-pressed={liveSession.mode === 'pty' && !channelIsLiveTui}
                 data-active={(liveSession.mode === 'pty' && !channelIsLiveTui) || undefined}
                 disabled={!channel?.enabled}
                 onClick={selectPtyMode}
                 title={channelReason}
               ><TerminalSquare size={14} aria-hidden="true" /> PTY</button>
               <button
                 type="button"
                 data-active={showInspector || undefined}
                 onClick={() => setShowInspector(!showInspector)}
                 title="Ver detalles / ACK inspector"
               ><Activity size={14} aria-hidden="true" /> Detalles</button>
            </div>
          </div>
        </header>

        <p className="terminal-channel-state" data-status={channel?.status ?? 'blocked'}>
          <ShieldCheck size={13} aria-hidden="true" />
          <strong>{channelLabel}</strong>
          <span>{channelReason}</span>
        </p>

        <p className="terminal-channel-state terminal-live-tui-state" data-status={liveTui.status}>
          <MonitorPlay size={13} aria-hidden="true" />
          <strong>{liveTuiLabel}</strong>
          <span>{liveTuiDetail}</span>
        </p>

        {/*
          🔴 El rechazo del gateway se veía SÓLO dentro del diálogo de motivo, y la TUI se pide
          sola al abrir la pestaña, sin diálogo. O sea que el camino por el que Steven entra —clic
          en un alias— recibía el 403 y no pintaba absolutamente nada: la pestaña se quedaba en el
          feed y el motivo moría en un `useState` que nadie renderiza. Ahora el motivo sale acá,
          en la propia sesión, con la misma redacción que en el diálogo.
        */}
        {requestError ? <NegativaPty negativa={requestError} /> : null}

        <div className="terminal-connection-bar" role="status">
          <span className={`connection-dot ${messages.error ? 'error' : ptyChannelLive ? 'open' : messages.data ? 'open' : 'connecting'}`} aria-hidden="true" />
          <strong>{messages.error ? 'FEED DEGRADADO' : ptyChannelLive ? 'POLLING EN PAUSA' : messages.data ? 'POLLING ACTIVO' : 'CONECTANDO'}</strong>
          <span>{messages.error?.message ?? (ptyChannelLive ? 'el canal PTY es la fuente en vivo de esta sesión' : 'deliveries + ACK cada 2.5 s')}</span>
          <button type="button" onClick={messages.reload} disabled={messages.loading}><RefreshCw size={13} aria-hidden="true" /> Sincronizar</button>
        </div>

        {liveSession.mode === 'pty' ? (
           channel?.enabled && grant && channel.websocketPath ? (
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
                   onClosed={() => onChannelClosed(liveSession.id)}
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
                 selectedDeliveryId={selectedDelivery?.delivery_id ?? undefined}
                 onSelectDelivery={(delivery: DeliveryView) => delivery.delivery_id && setSelectedDeliveryId(delivery.delivery_id)}
              />
            )}
            <form className="terminal-composer" onSubmit={(event) => void submit(event)}>
              <label htmlFor={`terminal-input-${liveSession.id}`}>Entrada para {liveSession.agent.alias}</label>
              <textarea
                id={`terminal-input-${liveSession.id}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
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
               {route && !route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
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
          error={requestError}
          onCancel={() => setShowPtyDialog(false)}
          onConfirm={(reason) => void requestChannel(reason, channelTarget?.modes.includes(SHELL_MODE) ? SHELL_MODE : channelTarget?.modes[0] ?? SHELL_MODE)}
        />
      ) : null}
    </div>
  );
}

interface GridContainerProps {
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
}

function GridContainer({
  sessions,
  activeId,
  agents,
  adapters,
  access,
  topologyAccess,
  capability,
  targets,
  grants,
  closedChannels,
  onActivate,
  onClose,
  onUpdate,
  onGrant,
  onChannelClosed,
  onReleaseChannel
}: GridContainerProps) {
  if (sessions.length === 0) {
    return (
      <div className="terminal-no-session" style={{ flex: 1 }}>
        <span><MessageSquareText size={27} aria-hidden="true" /></span>
        <p className="eyebrow">No active target</p>
        <h2>Abrí una sesión desde Fleet</h2>
        <p>Cada pestaña es una vista efímera sobre mensajes y ACK del servidor. No se persiste estado de sesión en el navegador.</p>
      </div>
    );
  }

  return (
    <div className="terminal-grid-wrapper">
      <div className="terminal-grid-container">
        {sessions.map((session) => (
          <div
            className="terminal-panel"
            key={session.id}
            data-active={session.id === activeId || undefined}
            onClick={() => onActivate(session.id)}
          >
            <header className="terminal-panel-header">
              <button
                className="terminal-panel-title-btn"
                type="button"
                role="tab"
                aria-selected={session.id === activeId}
                onClick={() => onActivate(session.id)}
              >
                <span className={`tab-live-dot ${session.agent.leaseState}`} aria-hidden="true" />
                <span><strong>{session.agent.alias}</strong><small>{session.agent.tenantId}</small></span>
              </button>
              <button
                className="terminal-panel-close"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
                aria-label={`Cerrar sesión ${session.agent.alias}`}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </header>
          <div className="terminal-panel-body">
            <SessionStage
              session={session}
              agents={agents}
              access={access}
                topologyAccess={topologyAccess}
                capability={capability}
                targets={targets}
                grants={grants}
                closedChannels={closedChannels}
                onUpdate={onUpdate}
                onGrant={onGrant}
                onChannelClosed={onChannelClosed}
                onReleaseChannel={onReleaseChannel}
              />
            </div>
          </div>
        ))}
      </div>
      <footer className="terminal-doctrine"><ShieldCheck size={14} aria-hidden="true" /> Cliente de transporte: no crea workers remotos, no ejecuta adapters y no persiste sesiones.</footer>
      <div className="terminal-adapter-mobile"><AdapterInspector adapters={adapters} access={access} capability={capability} /></div>
    </div>
  );
}

export function OperatorWorkspace({ agents, adapters, access, topologyAccess, terminalCapability, terminalTargets, fleetLoading, fleetError }: OperatorWorkspaceProps) {
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
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
      <GridContainer
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

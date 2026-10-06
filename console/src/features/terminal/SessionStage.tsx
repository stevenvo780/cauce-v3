import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CircleOff, MonitorPlay, TerminalSquare } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { LoadingState } from '../../components/ui';
import {
  TerminalApiError,
  type TerminalSessionGrant,
  type TerminalTargetsSnapshot,
} from './api';
import {
  prorrogarSesion,
} from './api-control';
import {
  LIVE_TUI_LABELS,
  LIVE_TUI_MODE,
  ofreceTuiEscribible,
  SHELL_MODE,
  TERMINAL_ACCESS_LABELS,
  terminalEsSoloLectura,
  terminalTargetForAgent,
  WRITABLE_TUI_MODE,
  type FleetAgent,
} from './fleet';
import {
  explicarDenegacionPty,
  traducirCodigosEnTexto,
  type DenegacionExplicada,
} from './denegaciones';
import { readPtySession, subscribePtySession } from './pty-session';
import { liveTuiGate, terminalChannelGate } from './plugin';
import { ptySecondsLeft, type OperatorSession } from './session';
import { ControlDeTui } from './ControlDeTui';
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
  const [showPtyDialog, setShowPtyDialog] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<DenegacionExplicada>();
  const [now, setNow] = useState(() => Date.now());
  const [controlSostenido, setControlSostenido] = useState(false);
  const [prorrogando, setProrrogando] = useState(false);
  const [ventanaHasta, setVentanaHasta] = useState<string>();
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

  const channelSessionId = grant ? grant.session_id : undefined;
  const subscribeChannel = useCallback(
    (listener: () => void) => channelSessionId ? subscribePtySession(channelSessionId, listener) : () => undefined,
    [channelSessionId],
  );
  const readChannel = useCallback(() => channelSessionId ? readPtySession(channelSessionId) : undefined, [channelSessionId]);
  const channelView = useSyncExternalStore(subscribeChannel, readChannel);

  useEffect(() => {
    if (!ptyChannelLive || channelView?.state === 'open') return;
    const interval = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [channelView?.state, ptyChannelLive]);

  const channel = terminalChannelGate(capability, access, targets, liveSession.agent);
  const channelLabel = channel.status !== 'blocked' ? TERMINAL_ACCESS_LABELS[channel.status] : 'PTY no habilitado';
  const channelTarget = terminalTargetForAgent(targets?.items, liveSession.agent);
  const liveTui = liveTuiGate(capability, access, targets, liveSession.agent);
  const liveTuiLabel = liveTui.status === 'blocked' ? 'TUI no habilitada' : LIVE_TUI_LABELS[liveTui.status];

  const channelReason = channel.reason
    ? traducirCodigosEnTexto(channel.reason)
    : 'Todavía no se pudo leer si hay canal PTY para este alias.';

  const targetMode = grant ? grant.target.mode : liveSession.channelMode;
  const channelIsLiveTui = targetMode === LIVE_TUI_MODE || targetMode === WRITABLE_TUI_MODE;
  const escrituraDisponible = (liveTui.status === 'available' || liveTui.status === 'no_tui')
    && ofreceTuiEscribible(channelTarget);
  const soloLectura = terminalEsSoloLectura(targetMode, controlSostenido);

  const requestChannelRef = useRef(requestChannel);
  requestChannelRef.current = requestChannel;

  /** Automatic opening of the live TUI when the panel is selected and it is available. */
  useEffect(() => {
    if (!liveTui.enabled && !escrituraDisponible) return;
    if (autoOpenedRef.current === liveSession.id) return;
    // Durable guard: survives the panel remount on a tab switch, which `autoOpenedRef` does not.
    if (liveSession.liveTuiAttempted) return;
    if (liveSession.id in grants || liveSession.id in closedChannels) return;
    autoOpenedRef.current = liveSession.id;
    const mode = escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE;
    void requestChannelRef.current(mode).catch(mostrarError);
  }, [closedChannels, grants, liveSession.agent.alias, liveSession.id, liveSession.liveTuiAttempted, liveTui.enabled, escrituraDisponible]);

  function mostrarError(error: unknown) {
    if (!mountedRef.current) return;
    setRequestError(explicarDenegacionPty({
      texto: error instanceof Error ? error.message : undefined,
      estado: error instanceof TerminalApiError ? error.status : undefined,
      codigo: error instanceof TerminalApiError ? error.code : undefined,
    }));
  }

  async function requestChannel(mode: string): Promise<TerminalSessionGrant | undefined> {
    const permitido = mode === LIVE_TUI_MODE
      ? liveTui.enabled
      : mode === WRITABLE_TUI_MODE ? escrituraDisponible : channel.enabled;
    if (!permitido) return undefined;
    if (requestAttemptRef.current !== undefined) return undefined;
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
      if (!ownsAttempt()) return undefined;
      const outcome = await onRequestGrant(liveSession.id, sessionToken, {
        tenant_id: liveSession.agent.tenantId,
        alias: liveSession.agent.alias,
        mode,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      if (!ownsAttempt() || !outcome.adopted) return undefined;
      setShowPtyDialog(false);
      setVentanaHasta(undefined);
      return outcome.grant;
    } catch (error) {
      if (!ownsAttempt()) return undefined;
      const explicada = explicarDenegacionPty({
        texto: error instanceof Error ? error.message : undefined,
        estado: error instanceof TerminalApiError ? error.status : undefined,
        codigo: error instanceof TerminalApiError ? error.code : undefined,
      });
      if (explicada.codigo === 'session_limit') {
        onReconciliarPlazas('session_limit');
      } else if (error instanceof TerminalApiError && error.code === 'invalid_grant_receipt') {
        onReconciliarPlazas('invalid_grant_receipt');
      }
      if (mode === WRITABLE_TUI_MODE) throw error;
      setRequestError(explicada);
      if (mode === LIVE_TUI_MODE) onUpdate({ ...liveSession, liveTuiAttempted: true });
      return undefined;
    } finally {
      if (requestAttemptRef.current === attempt) requestAttemptRef.current = undefined;
      if (mountedRef.current) setRequesting(false);
    }
  }

  async function prorrogar() {
    if (!grant || prorrogando) return;
    setProrrogando(true);
    setRequestError(undefined);
    try {
      const prorroga = await prorrogarSesion(grant.session_id, grant, api);
      setVentanaHasta(prorroga.expires_at);
    } catch (error) {
      setRequestError(explicarDenegacionPty({
        texto: error instanceof Error ? error.message : undefined,
        estado: error instanceof TerminalApiError ? error.status : undefined,
        codigo: error instanceof TerminalApiError ? error.code : undefined,
      }));
    } finally {
      if (mountedRef.current) setProrrogando(false);
    }
  }

  function openLiveTui() {
    if (!liveTui.enabled && !escrituraDisponible) return;
    if (grant !== undefined && !closedChannels[liveSession.id] && grant.target.mode === LIVE_TUI_MODE) {
      onUpdate({ ...liveSession, mode: 'pty' });
      return;
    }
    setRequestError(undefined);
    void requestChannel(escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE).catch(mostrarError);
  }

  /** Reopens the SAME channel that died: a read-only observation never becomes a writable shell. */
  async function pedirCanalNuevo() {
    const eraTui = channelIsLiveTui;
    await onReleaseChannel(liveSession.id);
    setRequestError(undefined);
    if (eraTui) {
      await requestChannelRef.current(escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE).catch(mostrarError);
      return;
    }
    setShowPtyDialog(true);
  }

  function selectPtyMode() {
    if (!channel.enabled) return;
    const current = grants[liveSession.id] as TerminalSessionGrant | undefined;
    if (current !== undefined && !closedChannels[liveSession.id] && current.target.mode === SHELL_MODE) {
      onUpdate({ ...liveSession, mode: 'pty' });
    } else {
      setRequestError(undefined);
      setShowPtyDialog(true);
    }
  }

  return (
    <div className="terminal-active-grid" id={`terminal-session-${liveSession.id}`} role="tabpanel">
      <section className="terminal-console">
        <header className="terminal-session-head">
          <div className="terminal-mode-switch" aria-label="Canal de sesión">
            <button type="button" aria-pressed={ptyChannelLive && channelIsLiveTui}
              data-active={(ptyChannelLive && channelIsLiveTui) || undefined}
              disabled={(!liveTui.enabled && !escrituraDisponible) || requesting}
              onClick={openLiveTui} title={`${liveTuiLabel}: ${traducirCodigosEnTexto(liveTui.reason)}`}>
              <MonitorPlay size={15} aria-hidden="true" /> TUI
            </button>
            <button type="button" aria-pressed={ptyChannelLive && !channelIsLiveTui}
              data-active={(ptyChannelLive && !channelIsLiveTui) || undefined}
              disabled={!channel.enabled || requesting} onClick={selectPtyMode}
              title={`Shell nueva en el espacio del agente. ${channelReason}`}>
              <TerminalSquare size={15} aria-hidden="true" /> Terminal
            </button>
          </div>
          {grant ? <PtySessionBar agent={liveSession.agent} grant={grant}
            secondsLeft={ptySecondsLeft(grant.expires_at, now)} readOnly={soloLectura}
            ticketConsumed={channelView?.ticketConsumido === true} ventanaHasta={ventanaHasta}
            prorrogando={prorrogando} onProrrogar={() => void prorrogar()} /> : null}
        </header>

        {requestError ? (
          <div className="terminal-channel-refusal">
            <NegativaPty negativa={requestError} />
            <button type="button" className="button small secondary" onClick={() => { setRequestError(undefined); }}>Descartar</button>
          </div>
        ) : null}

        {liveSession.mode === 'pty' ? (
          <>
            {channel.enabled && grant && channel.websocketPath ? (
             <div className="terminal-pty-pane">
               <Suspense fallback={<LoadingState label="Cargando Xterm…" />}>
                 <PtyTerminal
                   websocketPath={grant.websocket_path || channel.websocketPath}
                   sessionId={grant.session_id}
                   ticket={grant.ticket}
                   authorityProof={grant.authority_proof}
                   readOnly={soloLectura}
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
                ? 'Elegí TUI para la sesión viva o Terminal para abrir una shell en el espacio del agente.'
                : channelReason}</p>
            </div>
            )}
            {/* OUTSIDE the grant branch: taking the control swaps the read-only session for a
                writable one, and a control that unmounted in that gap would lose the hold it
                just took — and with it the only thing that can give the alias its queue back. */}
            <ControlDeTui
              alias={liveSession.agent.alias}
              grant={grant}
              puedeEscribir={escrituraDisponible && targetMode !== SHELL_MODE}
              codigoDeCierre={channelView?.closeCode}
              pidiendoSesion={requesting}
              sesionEnganchada={channelView?.ticketConsumido === true}
              estadoDelCanal={channelView?.state}
              onAbrirEscritura={() => requestChannelRef.current(WRITABLE_TUI_MODE)}
              onControlCambia={setControlSostenido}
            />
          </>
        ) : null}
      </section>

      {showPtyDialog ? (
        <PtySessionDialog
          agent={liveSession.agent}
          resolution={{ status: channel.status === 'blocked' ? 'unknown' : channel.status, reason: channel.reason, target: channelTarget }}
          pending={requesting}
          {...(requestError ? { error: requestError } : {})}
          onCancel={() => { setShowPtyDialog(false); }}
          onConfirm={() => void requestChannel(SHELL_MODE)}
        />
      ) : null}
    </div>
  );
}

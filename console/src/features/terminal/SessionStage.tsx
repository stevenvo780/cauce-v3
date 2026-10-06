import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, CircleOff, Loader2, MonitorPlay, Radio, TerminalSquare, X } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConsoleAccess, MessagePage, TerminalCapability } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { cn } from '../../cn';
import { AgentOrb } from '../../components/AgentOrb';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { TerminalApiError, type TerminalSessionGrant, type TerminalTargetsSnapshot } from './api';
import { prorrogarSesion } from './api-control';
import { AgentFeed } from './AgentFeed';
import { ControlDeTui } from './ControlDeTui';
import { explicarDenegacionPty, traducirCodigosEnTexto, type DenegacionExplicada } from './denegaciones';
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
import { ModeSwitch, type ModeOption } from './ModeSwitch';
import { NegativaPty } from './NegativaPty';
import type { MotivoReconciliacionPlaza } from './PlazasColgadas';
import { liveTuiGate, terminalChannelGate } from './plugin';
import { readPtySession, subscribePtySession } from './pty-session';
import { PtySessionBar } from './PtySessionBar';
import { ptySecondsLeft } from './session';
import { StageMenu } from './StageMenu';
import type { RequestTerminalGrant, StageMemory } from './types';

const PtyTerminal = lazy(() => import('./PtyTerminal'));

/** Geometry declared when asking for the grant; the real size is renegotiated on `ready`. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

type StageView = 'feed' | 'tui' | 'terminal';

function isTuiMode(mode: string | undefined): boolean {
  return mode === LIVE_TUI_MODE || mode === WRITABLE_TUI_MODE;
}

function explicar(error: unknown): DenegacionExplicada {
  return explicarDenegacionPty({
    texto: error instanceof Error ? error.message : undefined,
    estado: error instanceof TerminalApiError ? error.status : undefined,
    codigo: error instanceof TerminalApiError ? error.code : undefined,
  });
}

function Notice({ tone, icon, children, onDismiss }: {
  tone: 'warn' | 'neutral';
  icon: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <p
      role={tone === 'warn' ? 'alert' : 'status'}
      className={cn(
        'm-0 flex items-start gap-2 border-b px-3 py-1.5 text-[13px]',
        tone === 'warn' ? 'border-warn/30 bg-warn-soft text-warn-ink' : 'border-line bg-subtle text-muted',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Descartar" className="cursor-pointer rounded border-0 bg-transparent p-0.5 text-current hover:bg-black/5">
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </p>
  );
}

interface StageProps {
  agent: FleetAgent;
  sessionId: string;
  /** Incarnation of this opening. Leaving the agent and coming back produces a different token. */
  sessionToken: number;
  state: LiveState;
  memory: StageMemory;
  access?: ConsoleAccess;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  messages: Resource<MessagePage>;
  summary: string;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true | undefined>;
  /** Workspace-owned fence: survives stage unmounts. */
  onRequestGrant: RequestTerminalGrant;
  onMemory: (patch: StageMemory) => void;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
  /** A rejection left the seat state uncertain: the inventory is reread before acting. */
  onReconciliarPlazas: (motivo: MotivoReconciliacionPlaza) => void;
  onRefresh: () => void;
}

export function SessionStage({
  agent, sessionId, sessionToken, state, memory, access, capability, targets, messages, summary,
  grants, closedChannels, onRequestGrant, onMemory, onChannelClosed, onReleaseChannel, onReconciliarPlazas, onRefresh,
}: StageProps) {
  const api = useApi();
  const grant = grants[sessionId] as TerminalSessionGrant | undefined;
  const [view, setView] = useState<StageView>(() => (grant ? (isTuiMode(grant.target.mode) ? 'tui' : 'terminal') : 'feed'));
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<DenegacionExplicada>();
  const [now, setNow] = useState(() => Date.now());
  const [controlSostenido, setControlSostenido] = useState(false);
  const [prorrogando, setProrrogando] = useState(false);
  const [ventanaHasta, setVentanaHasta] = useState<string>();
  /** Opening that already tried its TUI on its own. It is not retried. */
  const autoOpenedRef = useRef<string>(undefined);
  /** Synchronous POST fence: auto-open and a click both enter before `setRequesting` renders. */
  const requestAttemptRef = useRef<{ sequence: number } | undefined>(undefined);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const channelLive = grant !== undefined && !closedChannels[sessionId];

  const channelSessionId = grant ? grant.session_id : undefined;
  const subscribeChannel = useCallback(
    (listener: () => void) => channelSessionId ? subscribePtySession(channelSessionId, listener) : () => undefined,
    [channelSessionId],
  );
  const readChannel = useCallback(() => channelSessionId ? readPtySession(channelSessionId) : undefined, [channelSessionId]);
  const channelView = useSyncExternalStore(subscribeChannel, readChannel);

  useEffect(() => {
    if (!channelLive || channelView?.state === 'open') return;
    const interval = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [channelView?.state, channelLive]);

  const channel = terminalChannelGate(capability, access, targets, agent);
  const channelLabel = channel.status !== 'blocked' ? TERMINAL_ACCESS_LABELS[channel.status] : 'PTY no habilitado';
  const channelTarget = terminalTargetForAgent(targets?.items, agent);
  const liveTui = liveTuiGate(capability, access, targets, agent);
  const liveTuiLabel = liveTui.status === 'blocked' ? 'TUI no habilitada' : LIVE_TUI_LABELS[liveTui.status];
  const channelReason = channel.reason
    ? traducirCodigosEnTexto(channel.reason)
    : 'Todavía no se pudo leer si hay canal PTY para este alias.';
  const tuiReason = traducirCodigosEnTexto(liveTui.reason);

  const targetMode = grant ? grant.target.mode : memory.channelMode;
  const channelIsLiveTui = isTuiMode(targetMode);
  const escrituraDisponible = (liveTui.status === 'available' || liveTui.status === 'no_tui')
    && ofreceTuiEscribible(channelTarget);
  const tuiEnabled = liveTui.enabled || escrituraDisponible;
  const soloLectura = terminalEsSoloLectura(targetMode, controlSostenido);
  // The inventory is what the operator saw before clicking; the grant's own target is the fallback.
  const sharingTarget = channelTarget?.shares_container_with.length ? channelTarget : grant?.target ?? channelTarget;
  const shared = sharingTarget?.shares_container_with ?? [];
  const sharedLabels = shared.map((identity) => (
    identity.tenant_id === sharingTarget?.tenant_id ? identity.alias : `${identity.tenant_id}:${identity.alias}`));

  const requestChannelRef = useRef(requestChannel);
  requestChannelRef.current = requestChannel;

  /** Automatic opening of the live TUI when the agent is selected and it is available. */
  useEffect(() => {
    if (!tuiEnabled) return;
    if (autoOpenedRef.current === sessionId) return;
    if (memory.liveTuiAttempted) return;
    if (sessionId in grants || sessionId in closedChannels) return;
    autoOpenedRef.current = sessionId;
    setView('tui');
    void requestChannelRef.current(escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE).catch(mostrarError);
  }, [closedChannels, grants, sessionId, memory.liveTuiAttempted, tuiEnabled, escrituraDisponible]);

  function mostrarError(error: unknown) {
    if (mountedRef.current) setRequestError(explicar(error));
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
      const current = grants[sessionId] as TerminalSessionGrant | undefined;
      if (current !== undefined && (current.target.mode !== mode || closedChannels[sessionId])) {
        await onReleaseChannel(sessionId);
      }
      if (!ownsAttempt()) return undefined;
      const outcome = await onRequestGrant(sessionId, sessionToken, {
        tenant_id: agent.tenantId,
        alias: agent.alias,
        mode,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      if (!ownsAttempt() || !outcome.adopted) return undefined;
      setVentanaHasta(undefined);
      return outcome.grant;
    } catch (error) {
      if (!ownsAttempt()) return undefined;
      const explicada = explicar(error);
      if (explicada.codigo === 'session_limit') {
        onReconciliarPlazas('session_limit');
      } else if (error instanceof TerminalApiError && error.code === 'invalid_grant_receipt') {
        onReconciliarPlazas('invalid_grant_receipt');
      }
      if (mode === WRITABLE_TUI_MODE) throw error;
      setRequestError(explicada);
      if (mode === LIVE_TUI_MODE) onMemory({ liveTuiAttempted: true });
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
      mostrarError(error);
    } finally {
      if (mountedRef.current) setProrrogando(false);
    }
  }

  function chooseTui() {
    setView('tui');
    if (!tuiEnabled) return;
    if (grant !== undefined && channelLive && isTuiMode(grant.target.mode)) return;
    setRequestError(undefined);
    void requestChannel(escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE).catch(mostrarError);
  }

  function chooseTerminal() {
    setView('terminal');
    if (!channel.enabled) return;
    if (grant !== undefined && channelLive && grant.target.mode === SHELL_MODE) return;
    setRequestError(undefined);
    void requestChannel(SHELL_MODE);
  }

  /** Reopens the SAME kind of channel that died: a read-only observation never becomes a writable shell. */
  async function pedirCanalNuevo() {
    const eraTui = channelIsLiveTui;
    await onReleaseChannel(sessionId);
    setRequestError(undefined);
    if (eraTui) await requestChannelRef.current(escrituraDisponible ? WRITABLE_TUI_MODE : LIVE_TUI_MODE).catch(mostrarError);
    else await requestChannelRef.current(SHELL_MODE);
  }

  function choose(next: StageView) {
    if (next === 'tui') chooseTui();
    else if (next === 'terminal') chooseTerminal();
    else setView('feed');
  }

  const options: ModeOption<StageView>[] = [
    { id: 'feed', label: 'Feed', icon: Radio, title: `Mensajes recientes de ${agent.alias}, sólo lectura` },
    {
      id: 'tui', label: 'TUI', icon: MonitorPlay, disabled: !tuiEnabled || requesting,
      title: `${liveTuiLabel}: ${tuiReason}`,
    },
    {
      id: 'terminal', label: 'Terminal', icon: TerminalSquare, disabled: !channel.enabled || requesting,
      title: `Shell nueva en el espacio del agente. ${channelReason}${sharedLabels.length ? ` Contenedor compartido con ${sharedLabels.join(', ')}.` : ''}`,
    },
  ];

  const wantsTui = view === 'tui';
  const paneMatchesView = grant !== undefined && wantsTui === channelIsLiveTui;
  const paneEnabled = channelIsLiveTui ? tuiEnabled : channel.enabled;
  const paneSocketPath = grant ? [grant.websocket_path, channel.websocketPath, liveTui.websocketPath].find((path) => path !== undefined && path !== '') : undefined;
  const viewEnabled = wantsTui ? tuiEnabled : channel.enabled;
  const ptyClosedAll = !tuiEnabled && !channel.enabled;
  const tone = TONE_CLASS[STATE_TONE[state]];

  return (
    <div className="flex min-h-0 flex-1 flex-col" id={`terminal-session-${sessionId}`}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2 min-[761px]:flex-nowrap">
        <div className="order-1 flex min-w-0 flex-1 items-center gap-2.5 min-[761px]:flex-none">
          <AgentOrb seed={`${agent.tenantId}/${agent.alias}`} state={state} size={28} />
          <h2 className="m-0 flex min-w-0 items-baseline gap-1.5 text-sm font-semibold">
            <span className="truncate">{agent.alias}</span>
            <span className="truncate text-xs font-normal text-muted">{agent.tenantId}</span>
          </h2>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone.pill)} title={LIVE_STATE_META[state].hint}>
            {LIVE_STATE_META[state].label}
          </span>
        </div>
        <ModeSwitch
          label="Vista de la sesión"
          value={view}
          options={options}
          onChange={choose}
          className="order-3 w-full min-[761px]:order-2 min-[761px]:w-auto"
        />
        <div className="order-2 ml-auto flex items-center gap-1 min-[761px]:order-3">
          {grant ? (
            <PtySessionBar
              agent={agent}
              grant={grant}
              secondsLeft={ptySecondsLeft(grant.expires_at, now)}
              readOnly={soloLectura}
              ticketConsumed={channelView?.ticketConsumido === true}
              ventanaHasta={ventanaHasta}
            />
          ) : null}
          <StageMenu
            hasGrant={grant !== undefined}
            canExtend={channelView?.ticketConsumido === true}
            extending={prorrogando}
            onExtend={() => void prorrogar()}
            onClose={() => { void onReleaseChannel(sessionId); }}
            onRefresh={onRefresh}
            summary={summary}
          />
        </div>
      </header>

      {requestError ? (
        <div className="shrink-0 border-b border-line p-2">
          <NegativaPty negativa={requestError} />
          <button type="button" className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-xs text-muted underline hover:text-fg" onClick={() => { setRequestError(undefined); }}>
            Descartar
          </button>
        </div>
      ) : null}

      {view === 'feed' && ptyClosedAll ? (
        <Notice tone="neutral" icon={<CircleOff size={14} aria-hidden="true" />}>
          <strong className="font-medium text-fg-2">{channelLabel}.</strong> {channelReason}
        </Notice>
      ) : null}

      {view === 'terminal' && shared.length ? (
        <Notice tone="warn" icon={<AlertTriangle size={14} aria-hidden="true" />}>
          Este contenedor lo comparten <strong>{sharedLabels.join(', ')}</strong>. Una shell acá no es “la terminal de {agent.alias}”:
          es acceso al home donde conviven {[agent.alias, ...sharedLabels].join(', ')}.
        </Notice>
      ) : null}

      {/* OUTSIDE the grant branch: taking the control swaps the read-only session for a writable
          one, and a control that unmounted in that gap would lose the hold it just took — and with
          it the only thing that can give the alias its queue back. Hidden, never unmounted. */}
      <div hidden={view !== 'tui'}>
        <ControlDeTui
          alias={agent.alias}
          grant={grant}
          puedeEscribir={grant !== undefined && escrituraDisponible && targetMode !== SHELL_MODE}
          codigoDeCierre={channelView?.closeCode}
          pidiendoSesion={requesting}
          sesionEnganchada={channelView?.ticketConsumido === true}
          estadoDelCanal={channelView?.state}
          onAbrirEscritura={() => requestChannelRef.current(WRITABLE_TUI_MODE)}
          onControlCambia={setControlSostenido}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'feed' ? (
          <AgentFeed agent={agent} messages={messages} />
        ) : paneMatchesView && paneEnabled && paneSocketPath ? (
          <Suspense fallback={<p className="m-0 p-4 text-[13px] text-muted" role="status">Cargando Xterm…</p>}>
            <PtyTerminal
              websocketPath={paneSocketPath}
              sessionId={grant.session_id}
              ticket={grant.ticket}
              authorityProof={grant.authority_proof}
              readOnly={soloLectura}
              onClosed={() => { onChannelClosed(sessionId); }}
              onRequestNewSession={() => { void pedirCanalNuevo(); }}
            />
          </Suspense>
        ) : (
          <div className="grid flex-1 place-content-center justify-items-center gap-1.5 p-6 text-center" data-canal-no-disponible="">
            {requesting
              ? <Loader2 size={20} aria-hidden="true" className="animate-spin text-muted" />
              : <CircleOff size={20} aria-hidden="true" className="text-muted" />}
            <h3 className="m-0 text-sm font-semibold">
              {requesting ? 'Abriendo el canal…' : viewEnabled ? 'No hay canal PTY abierto' : wantsTui ? liveTuiLabel : channelLabel}
            </h3>
            {requesting || viewEnabled ? null : (
              <p className="m-0 max-w-md text-[13px] text-muted">{wantsTui ? tuiReason : channelReason}</p>
            )}
            {!requesting && viewEnabled ? (
              <button type="button" className="button small primary mt-1" onClick={() => { choose(view); }}>
                {wantsTui ? 'Abrir TUI en vivo' : 'Abrir terminal'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

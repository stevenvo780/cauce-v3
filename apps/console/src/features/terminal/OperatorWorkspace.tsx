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
import type { AdapterView, ConsoleAccess, TerminalCapability, TopologySnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, permissionState, safeCapabilityState } from '../../lib';
import { publishDurably } from '../messages/durable-publish';
import { exactCancelReceipt, exactReplayReceipt } from '../queues/delivery-receipts';
import { AckInspector } from './AckInspector';
import { FleetSidebar } from './FleetSidebar';
import {
  TerminalApiError,
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  rotateTerminalSessionOwner,
  type CreateTerminalSessionInput,
  type TerminalSessionGrant,
  type TerminalSessionListItem,
  type TerminalTargetsSnapshot,
} from './api';
import { minutosParaLiberar, plazasColgadas, plazasOcupadas } from './plazas';
import type { FleetAgent } from './fleet';
import {
  ADAPTER_STATE_LABELS,
  LEASE_STATE_LABEL,
  LIVE_TUI_LABELS,
  LIVE_TUI_MODE,
  SHELL_MODE,
  TERMINAL_ACCESS_LABELS,
  terminalTargetForAgent,
  type TerminalTargetResolution,
} from './fleet';
import { explicarDenegacionPty, traducirCodigosEnTexto, type DenegacionExplicada } from './denegaciones';
import { TEXTO_DOCTRINA } from './doctrina';
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
  /**
   * Cuántas sesiones hay abiertas. La página lo necesita para entrar en modo observación: con una
   * sesión abierta el terminal es el contenido y los seis contadores se repliegan. La cuenta la
   * tiene este componente, no la página.
   */
  onSesionesAbiertas?: (cantidad: number) => void;
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
 * Componente para mostrar denegaciones de acceso PTY con explicación y código.
 */
function NegativaPty({ negativa }: { negativa: DenegacionExplicada }) {
  return (
    <div
      className="pty-negativa"
      role="alert"
      data-codigo={negativa.codigo}
      // La culpa va en el propio `[role=alert]` y no en un envoltorio: es lo que decide el color y
      // el tono, y quien lee el aviso con un lector de pantalla no ve el envoltorio.
      data-consola={negativa.esDefectoDeLaConsola || undefined}
    >
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
  const sharedLabels = shared.map((identity) =>
    identity.tenant_id === target?.tenant_id ? identity.alias : `${identity.tenant_id}:${identity.alias}`);

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
              Este contenedor lo comparten <strong>{sharedLabels.join(', ')}</strong>. Una shell acá no es “la terminal de {agent.alias}”:
              es acceso al home donde conviven {[agent.alias, ...sharedLabels].join(', ')}.
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
      {/*
        El id de contenedor es de 64 caracteres y se pintaba ENTERO: se llevaba una línea de la
        barra él solo, y la barra crecía a 95 px de alto por encima del terminal. Se recorta como
        el resto de identificadores de la consola y el completo queda en el `title`, que es donde
        hace falta cuando hay que copiarlo.
      */}
      {/* `pty-bar-dato`: los tres datos de contexto. Se repliegan en pantalla estrecha, donde la
          barra se partía en cinco renglones y empujaba el terminal fuera de la pantalla. */}
      <span className="pty-bar-dato" title={grant.target.container ?? undefined}><Container size={13} aria-hidden="true" /> <span className="mono">{grant.target.container ? compactId(grant.target.container) : <Unknown value={grant.target.container} />}</span></span>
      <span className="pty-bar-dato"><UserCog size={13} aria-hidden="true" /> <span className="mono"><Unknown value={grant.target.runtime_user} /></span></span>
      <span className="pty-bar-dato"><Braces size={13} aria-hidden="true" /> <span className="mono">{grant.target.mode}</span></span>
      <span className="pty-bar-countdown" data-expiring={!ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10 ? 'true' : undefined}>
        <Timer size={13} aria-hidden="true" />
        {ticketConsumed
          ? <>Ticket consumido · <strong>sesión activa</strong></>
          : <>Ticket vence en <strong>{formatCountdown(secondsLeft)}</strong></>}
      </span>
      {/*
        Que el polling del feed se haya parado se decía en una barra propia de 32 px por encima
        del terminal («POLLING EN PAUSA · el canal PTY es la fuente en vivo»). El dato es cierto y
        vale, el renglón entero no: acá cabe en la barra que ya existe, sin robarle alto a lo que
        se está mirando.
      */}
      <span className="pty-bar-feed"><MessageSquareText size={13} aria-hidden="true" /> POLLING EN PAUSA</span>
      {/*
        SE LLAMABA IGUAL QUE EL BOTÓN QUE TE ECHA DE LA CONSOLA. Arriba a la derecha, en la barra
        de la aplicación, hay un «Cerrar sesión» que cierra la SESIÓN DE STEVEN. Éste cerraba el
        canal PTY y decía exactamente lo mismo; en el móvil quedaba además a ancho completo y bien
        visible. Dos botones con el mismo rótulo y consecuencias distintas es una trampa, no un
        detalle de redacción.
      */}
      <button className="button small secondary pty-bar-close" type="button" onClick={onClose} disabled={closing} title="Cierra el canal PTY de este alias. No cierra tu sesión de la consola.">
        <PowerOff size={13} aria-hidden="true" /> {closing ? 'Cerrando…' : 'Cerrar la terminal'}
      </button>
    </div>
  );
}

function AdapterInspector({ adapters, access, capability }: { adapters: AdapterView[]; access?: ConsoleAccess; capability?: TerminalCapability }) {
  return (
    <>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Autorización</p><h3>Permisos efectivos</h3></div><ShieldCheck size={18} aria-hidden="true" /></header>
        <div className="terminal-permissions">
          <PermissionState access={access} permission="ultimate-terminal.connect" />
          <PermissionState access={access} permission="message.publish" />
          <PermissionState access={access} permission="delivery.replay" />
        </div>
        <p className="inspector-footnote">Roles: {access?.roles?.length ? access.roles.join(', ') : 'sin dato'}. La UI no eleva permisos faltantes.</p>
      </section>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Plano de transporte</p><h3>Adaptadores</h3></div><Bot size={18} aria-hidden="true" /></header>
        <div className="terminal-adapter-list">
          {adapters.length ? adapters.map((adapter, index) => (
            <article key={adapter.id ?? index}>
              <span className={`adapter-state-dot ${adapter.state ?? 'unknown'}`} aria-hidden="true" />
              <div><strong><Unknown value={adapter.label ?? adapter.id} /></strong><small>{adapter.capabilities?.length ?? 'sin dato de'} capacidades</small></div>
              {/*
                Acá se imprimía, literalmente y en pantalla, «<UNKNOWN VALUE=AVAILABLE />»: un
                `&lt;Unknown value={...} /&gt;` escapado que el navegador pintaba como texto. Además
                de ser jerga cruda, se contradecía: «UNKNOWN VALUE=AVAILABLE» no le dice a nadie si
                el adaptador está o no. Ahora se pinta el estado, en palabras.
              */}
              <Badge tone={adapter.state === 'available' ? 'online' : adapter.state === 'degraded' ? 'warning' : adapter.state === 'unavailable' ? 'offline' : 'unknown'}>
                {ADAPTER_STATE_LABELS[safeCapabilityState(adapter.state) ?? 'unknown']}
              </Badge>
            </article>
          )) : <EmptyState>Adaptadores no informados.</EmptyState>}
        </div>
      </section>
      <section className="terminal-inspector-section terminal-pty-capability">
        <header className="inspector-title"><div><p className="eyebrow">Canal opcional</p><h3>PTY directo</h3></div><TerminalSquare size={18} aria-hidden="true" /></header>
        <dl>
          <div><dt>Estado</dt><dd>{capability?.available === true ? 'Disponible' : capability?.available === false ? 'No disponible' : 'sin dato'}</dd></div>
          <div><dt>Destino</dt><dd><Unknown value={capability?.target_label} /></dd></div>
          <div><dt>Ruta WebSocket</dt><dd className="mono"><Unknown value={capability?.websocket_path} /></dd></div>
        </dl>
        <p className="inspector-footnote">La autoridad por destino la da el servidor en cada target, no este resumen.</p>
      </section>
    </>
  );
}

type MotivoReconciliacionPlaza = 'session_limit' | 'invalid_grant_receipt';

interface TerminalGrantRequestOutcome {
  grant: TerminalSessionGrant;
  adopted: boolean;
}

type RequestTerminalGrant = (
  sessionId: string,
  sessionToken: number,
  input: Omit<CreateTerminalSessionInput, 'request_id' | 'owner_token'>,
) => Promise<TerminalGrantRequestOutcome>;

interface WorkspaceTerminalAttempt {
  readonly id: symbol;
  /** Only a remount of this exact tab incarnation may adopt the in-flight POST. */
  readonly sessionToken: number;
  readonly inputKey: string;
  readonly subscribers: Set<number>;
  readonly promise: Promise<TerminalGrantRequestOutcome>;
}

interface WorkspaceTerminalIntent {
  readonly sessionToken: number;
  readonly inputKey: string;
  readonly requestId: string;
  readonly ownerToken: string;
}

function terminalRequestInputKey(input: Omit<CreateTerminalSessionInput, 'request_id' | 'owner_token'>): string {
  return JSON.stringify([
    input.tenant_id, input.alias, input.mode, input.reason, input.cols, input.rows,
  ]);
}

function terminalCapabilityUuid(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (value === undefined) {
    throw new Error('Este navegador no ofrece UUID seguros para cercar la sesión PTY.');
  }
  return value;
}

function SessionStage({ session, sessionToken, agents, access, topologyAccess, capability, targets, grants, closedChannels, onUpdate, onRequestGrant, onChannelClosed, onReleaseChannel, onReconciliarPlazas }: {
  session: OperatorSession;
  /** Incarnation of this tab. Closing and reopening the same alias produces a different token. */
  sessionToken: number;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true>;
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
  const grant = grants[liveSession.id];
  const ptyChannelLive = Boolean(liveSession.mode === 'pty' && grant && !closedChannels[liveSession.id]);
  /** El terminal está a la vista y pintando: lo accesorio deja de robarle alto. */
  const mostrandoTui = ptyChannelLive && liveSession.mode === 'pty';

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
  const selectedDelivery = deliveries.find((delivery) => (
    selectedDeliveryId != null && delivery.delivery_id === selectedDeliveryId
  )) ?? deliveries.at(-1);
  /*
   * `TerminalTranscript` marca por MENSAJE :
   * comparar dos `undefined` ponía el anillo azul en todas las burbujas de salida). Este panel
   * sigue razonando por entrega —su inspector de ACK sólo existe para una entrega—, así que acá se
   * traduce: qué mensaje contiene la entrega elegida. Sin entregas en el hilo no hay mensaje
   * marcado, en vez de estar marcados todos.
   */
  const selectedMessageId = transcript.find((item) => (
    selectedDelivery?.delivery_id != null && item.delivery?.delivery_id === selectedDelivery.delivery_id
  ))?.message.message_id ?? undefined;
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
  /** Apertura automática de TUI viva al seleccionar el panel si está disponible. */
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
    const result = await api.replayDelivery(deliveryId);
    if (!exactReplayReceipt(result, deliveryId)) {
      messages.reload();
      throw new Error('El gateway no devolvió un recibo durable exacto del replay.');
    }
    messages.reload();
  }

  async function cancel(deliveryId: string) {
    const result = await api.cancelDelivery(deliveryId);
    if (!exactCancelReceipt(result, deliveryId)) {
      messages.reload();
      throw new Error('El gateway no devolvió un recibo durable exacto de la cancelación.');
    }
    messages.reload();
  }

  async function requestChannel(reason: string, mode: string) {
    if (mode === LIVE_TUI_MODE ? !liveTui.enabled : !channel?.enabled) return;
    // This ref is assigned before the first await and before React can render `requesting`.
    if (requestAttemptRef.current !== undefined) return;
    const attempt = { sequence: ++requestSequenceRef.current };
    requestAttemptRef.current = attempt;
    const ownsAttempt = () => mountedRef.current && requestAttemptRef.current === attempt;
    setRequesting(true);
    setRequestError(undefined);
    try {
      // Un grant es de UN modo. Pasar de la TUI a una shell (o al revés) no es cambiar de
      // pestaña: es otra autorización, con su motivo y su fila de auditoría. La sesión anterior
      // se suelta contra el servidor primero, para no dejarla colgada del otro lado.
      const current = grants[liveSession.id];
      if (current && (current.target.mode !== mode || closedChannels[liveSession.id])) {
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
      // Adoption/compensation lives in the workspace so switching tabs cannot discard its fence.
      // This stage only updates its own dialog when the exact mounted caller still owns the await.
      if (!ownsAttempt() || !outcome.adopted) return;
      setShowPtyDialog(false);
    } catch (error) {
      if (!ownsAttempt()) return;
      // El rechazo se TRADUCE acá, en el único sitio por el que pasan los ocho códigos del
      // gateway. `TerminalApiError` trae el estado HTTP y el `error` del cuerpo; los dos hacían
      // falta y ninguno se estaba mostrando.
      const explicada = explicarDenegacionPty({
        texto: error instanceof Error ? error.message : undefined,
        estado: error instanceof TerminalApiError ? error.status : undefined,
        codigo: error instanceof TerminalApiError ? error.code : undefined,
      });
      setRequestError(explicada);
      // «Cerrá alguna de las sesiones que tenés abiertas» sólo es una instrucción si el operador
      // PUEDE verlas: acá es donde se van a buscar, en el único momento en que hacen falta.
      if (explicada.codigo === 'session_limit') {
        onReconciliarPlazas('session_limit');
      } else if (error instanceof TerminalApiError && error.code === 'invalid_grant_receipt') {
        // El id del recibo roto no es confiable. La unica reconciliacion segura es un GET exacto
        // y visible; cualquier cierre posterior queda como accion explicita del operador.
        onReconciliarPlazas('invalid_grant_receipt');
      }
      // Un rechazo se cuenta como intento: la apertura automática no vuelve a golpear al gateway.
      if (mode === LIVE_TUI_MODE) onUpdate({ ...liveSession, liveTuiAttempted: true });
    } finally {
      if (requestAttemptRef.current === attempt) requestAttemptRef.current = undefined;
      if (mountedRef.current) setRequesting(false);
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
             <label className="terminal-room-label">Room de origen
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
                 disabled={!liveTui.enabled || requesting}
                 onClick={openLiveTui}
                 title={traducirCodigosEnTexto(liveTui.reason)}
               ><MonitorPlay size={14} aria-hidden="true" /> TUI</button>
               <button
                 type="button"
                 aria-pressed={liveSession.mode === 'pty' && !channelIsLiveTui}
                 data-active={(liveSession.mode === 'pty' && !channelIsLiveTui) || undefined}
                 disabled={!channel?.enabled || requesting}
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

        {/*
          Las dos filas de estado del canal («PTY online: ok» y «El servidor publica el modo
          harness: hay TUI en vivo para este alias») valen ORO mientras la TUI no se ve: son el
          motivo escrito de por qué no emite. Con el terminal ya pintando, son 56 px de alto que
          repiten lo que se está viendo, y ese alto sale del único sitio del que puede salir: del
          terminal. Medido a 1280x900: con las dos filas y la barra del feed, al terminal le
          quedaban 12 filas de texto. Se muestran exactamente cuando informan.
        */}
        {mostrandoTui ? null : (
          <>
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
          </>
        )}

        {/*
          El rechazo del gateway se veía SÓLO dentro del diálogo de motivo, y la TUI se pide
          sola al abrir la pestaña, sin diálogo. O sea que el camino por el que Steven entra —clic
          en un alias— recibía el 403 y no pintaba absolutamente nada: dos 403 y el panel seguía
          diciendo «PTY online» y «TUI en vivo» mientras el motivo moría en un `useState` que nadie
          renderiza. Ahora sale acá, en la propia sesión, con la misma redacción que en el diálogo
          —una sola— y se puede descartar.
        */}
        {requestError ? (
          <div className="terminal-channel-refusal">
            <NegativaPty negativa={requestError} />
            <button type="button" className="button small secondary" onClick={() => setRequestError(undefined)}>Descartar</button>
          </div>
        ) : null}

        {/* La barra del feed describe el POLLING de mensajes; con la TUI en pantalla decía, ella
            sola, «POLLING EN PAUSA · el canal PTY es la fuente en vivo». Cierto e inútil ahí. */}
        {mostrandoTui ? null : (
          <div className="terminal-connection-bar" role="status">
            <span className={`connection-dot ${messages.error ? 'error' : ptyChannelLive ? 'open' : messages.data ? 'open' : 'connecting'}`} aria-hidden="true" />
            <strong>{messages.error ? 'FEED DEGRADADO' : ptyChannelLive ? 'POLLING EN PAUSA' : messages.data ? 'POLLING ACTIVO' : 'CONECTANDO'}</strong>
            <span>{messages.error?.message ?? (ptyChannelLive ? 'el canal PTY es la fuente en vivo de esta sesión' : 'deliveries + ACK cada 2.5 s')}</span>
            <button type="button" onClick={messages.reload} disabled={messages.loading}><RefreshCw size={13} aria-hidden="true" /> Sincronizar</button>
          </div>
        )}

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
                 selectedMessageId={selectedMessageId}
                 onSelectItem={(item) => item.delivery?.delivery_id && setSelectedDeliveryId(item.delivery.delivery_id)}
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
          {...(requestError ? { error: requestError } : {})}
          onCancel={() => setShowPtyDialog(false)}
          onConfirm={(reason) => void requestChannel(reason, SHELL_MODE)}
        />
      ) : null}
    </div>
  );
}

/**
 * Componente para listar y liberar sesiones de terminal huérfanas o fuera de foco.
 */
function PlazasColgadas({ items, aLaVista, topeAlcanzado, motivo, revisando, cerrando, error, onRevisar, onCerrar }: {
  /** Las que ocupan plaza y esta pestaña NO gobierna: las colgadas de verdad. */
  items: TerminalSessionListItem[];
  /** Cuántas de las que ocupan plaza sí están a la vista como pestañas de esta pantalla. */
  aLaVista: number;
  /** El gateway acaba de contestar `session_limit`: hay que decir con QUÉ se gastó el tope. */
  topeAlcanzado: boolean;
  /** Por qué se hizo la lectura causal que sostiene este cartel. */
  motivo?: MotivoReconciliacionPlaza;
  revisando: boolean;
  cerrando: Record<string, true>;
  /** Un inventario ilegible es UNKNOWN: nunca equivale a cero plazas ocupadas. */
  error?: string;
  onRevisar: () => void;
  onCerrar: (sessionId: string) => void;
}) {
  if (items.length === 0 && !topeAlcanzado) return null;
  const ahora = Date.now();
  /*
   * Dos situaciones distintas y una sola tira, porque para el operador el problema es el mismo
   * («no puedo abrir otra») y la salida NO es la misma:
   *  · si hay colgadas, la salida es cerrarlas desde acá, que es lo único que no podía hacer;
   *  · si todas están a la vista, la salida es cerrar una pestaña — y entonces lo que hay que
   *    decir es exactamente eso, no repetir «cerrá alguna de las que tenés abiertas».
   */
  const total = items.length + aLaVista;
  return (
    <section className="pty-plazas" aria-label="Sesiones de terminal que siguen ocupando plaza">
      <header>
        <AlertTriangle size={15} aria-hidden="true" />
        <div>
          <strong>
            {error
              ? 'No se pudo leer qué sesiones están ocupando el tope'
              : items.length === 0 && aLaVista === 0 && motivo === 'session_limit'
                ? 'El tope se liberó antes de terminar la verificación'
              : items.length === 0 && aLaVista === 0 && motivo === 'invalid_grant_receipt'
                ? 'El grant fue inválido y no hay una reserva visible'
              : motivo === 'invalid_grant_receipt' && items.length > 0
                ? 'El grant fue inválido; estas son las reservas visibles'
              : items.length === 0
              ? `Tope de sesiones alcanzado: las ${total} que lo gastan están abiertas acá`
              : items.length === 1
                ? 'Una sesión tuya sigue ocupando plaza fuera de esta pantalla'
                : `${items.length} sesiones tuyas siguen ocupando plaza fuera de esta pantalla`}
          </strong>
          <p>
            {error
              ? items.length === 0
                ? 'El inventario del gateway no es verificable. No se infiere que haya cero sesiones ni que todas estén abiertas en esta pantalla. Reintentá la lectura antes de decidir qué cerrar.'
                : `No se pudo actualizar el inventario. Las ${items.length} filas de abajo son el último inventario verificable y pueden estar desactualizadas; no prueban cuántas plazas siguen ocupadas ahora.`
              : items.length === 0 && aLaVista === 0 && motivo === 'session_limit'
                ? 'El POST recibió 409, pero el GET exacto posterior ya no encontró ninguna sesión ocupando plaza. Hubo una liberación concurrente: no hay nada que cerrar y podés reintentar la apertura.'
              : items.length === 0 && aLaVista === 0 && motivo === 'invalid_grant_receipt'
                ? 'No se revocó el session_id del recibo roto porque no era confiable. El inventario exacto posterior no muestra una reserva que puedas cerrar; reintentá sólo después de releer si el estado cambia.'
              : motivo === 'invalid_grant_receipt' && items.length > 0
                ? 'No se usó el session_id del recibo roto para borrar nada. Las filas de abajo vienen del GET exacto posterior: cerrá una sólo si reconocés que esa reserva ya no debe seguir viva.'
              : items.length === 0
              ? 'El tope de sesiones simultáneas es por operador y ya lo gastaste con las pestañas de arriba. '
                + 'Cerrá una con su aspa y volvé a pedir la que querías: se libera al instante.'
              : 'El tope de sesiones simultáneas es por operador, así que estas cuentan aunque su pestaña ya no exista '
                + '—otra ventana, un cierre a lo bruto, una recarga a destiempo—. Mientras sigan vivas, abrir otra TUI '
                + 'devuelve 409. Se sueltan solas al vencer; el botón las suelta ahora.'}
          </p>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
        <button className="button small secondary" type="button" onClick={onRevisar} disabled={revisando}>
          <RefreshCw size={13} aria-hidden="true" /> {revisando ? 'Revisando…' : 'Revisar'}
        </button>
      </header>
      {items.length === 0 ? null : (
      <ul>
        {items.map((item) => (
          <li key={item.session_id}>
            <span className="pty-plazas-alias"><Bot size={12} aria-hidden="true" /> <strong>{item.alias}</strong> <small>{item.tenant_id}</small></span>
            <span className="pty-plazas-modo">{item.mode === LIVE_TUI_MODE ? 'TUI en vivo' : item.mode === SHELL_MODE ? 'shell' : item.mode}</span>
            <span className="pty-plazas-resto"><Timer size={12} aria-hidden="true" /> se suelta sola en {minutosParaLiberar(item, ahora)} min</span>
            <button className="button small" type="button" onClick={() => onCerrar(item.session_id)} disabled={Boolean(cerrando[item.session_id])}>
              <PowerOff size={13} aria-hidden="true" /> {cerrando[item.session_id] ? 'Cerrando…' : 'Cerrar ahora'}
            </button>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}

interface GridContainerProps {
  sessions: OperatorSession[];
  sessionTokens: ReadonlyMap<string, number>;
  activeId?: string;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onUpdate: (session: OperatorSession) => void;
  onRequestGrant: RequestTerminalGrant;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
  onReconciliarPlazas: (motivo: MotivoReconciliacionPlaza) => void;
}

function GridContainer({
  sessions,
  sessionTokens,
  activeId,
  agents,
  access,
  topologyAccess,
  capability,
  targets,
  grants,
  closedChannels,
  onActivate,
  onClose,
  onUpdate,
  onRequestGrant,
  onChannelClosed,
  onReleaseChannel,
  onReconciliarPlazas
}: GridContainerProps) {
  if (sessions.length === 0) {
    return (
      <div className="terminal-no-session" style={{ flex: 1 }}>
        <span><MessageSquareText size={27} aria-hidden="true" /></span>
        <p className="eyebrow">Ningún agente seleccionado</p>
        <h2>Abrí una sesión desde la flota</h2>
        <p>Cada pestaña es una vista efímera sobre mensajes y ACK del servidor. No se persiste estado de sesión en el navegador.</p>
      </div>
    );
  }

  /*
   * UNA SESIÓN A LA VISTA, NO TODAS APILADAS.
   *
   * La rejilla pintaba TODOS los paneles abiertos, cada uno con `height: 600px`, uno debajo de
   * otro. Medido a 1280x900 con cuatro sesiones: la página medía 3.058 px para una ventana de
   * 1.000, las cabeceras caían en y=545/1161/1777/2393 y del terminal de 500 px se veían 144.
   * Activar una pestaña no movía el scroll ni un píxel (scrollTop 0 antes y después), así que
   * hacer clic en un agente no mostraba nada: había que ir a buscarlo con la rueda.
   *
   * Ahora las sesiones abiertas son PESTAÑAS y el escenario es uno solo, que se queda con todo el
   * alto disponible. Desmontar el panel no mata la sesión: el nodo del terminal, su socket y su
   * scrollback los gobierna `pty-session.ts` fuera de React, que es exactamente para lo que ese
   * módulo existe.
   */
  const visible = sessions.find((session) => session.id === activeId) ?? sessions[0];
  return (
    <div className="terminal-grid-wrapper">
      <nav className="terminal-session-tabs" role="tablist" aria-label="Sesiones abiertas">
        {sessions.map((session) => (
          <span className="terminal-session-tab" key={session.id} data-active={session.id === visible?.id || undefined}>
            <button
              className="terminal-panel-title-btn"
              type="button"
              role="tab"
              aria-selected={session.id === visible?.id}
              aria-controls={`terminal-session-${session.id}`}
              onClick={() => onActivate(session.id)}
            >
              <span className={`tab-live-dot ${session.agent.leaseState}`} aria-hidden="true" />
              <span><strong>{session.agent.alias}</strong><small>{session.agent.tenantId}</small></span>
            </button>
            <button
              className="terminal-panel-close"
              type="button"
              onClick={(event) => { event.stopPropagation(); onClose(session.id); }}
              aria-label={`Cerrar sesión ${session.agent.alias}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </span>
        ))}
      </nav>
      <div className="terminal-grid-container">
        {visible ? (
          <div className="terminal-panel" data-active="true" key={visible.id}>
            <div className="terminal-panel-body">
              <SessionStage
                session={visible}
                sessionToken={sessionTokens.get(visible.id) ?? 0}
                agents={agents}
                access={access}
                topologyAccess={topologyAccess}
                capability={capability}
                targets={targets}
                grants={grants}
                closedChannels={closedChannels}
                onUpdate={onUpdate}
                onRequestGrant={onRequestGrant}
                onChannelClosed={onChannelClosed}
                onReleaseChannel={onReleaseChannel}
                onReconciliarPlazas={onReconciliarPlazas}
              />
            </div>
          </div>
        ) : null}
      </div>
      {/*
        El pie se repliega en modo observación (ver `terminal-panel.css`): 30 px que dicen una
        frase que no cambia nunca, tomados del único sitio del que pueden salir —el terminal—. La
        frase no se pierde: la misma constante se escribe en el desplegable de la cabecera.
      */}
      <footer className="terminal-doctrine"><ShieldCheck size={14} aria-hidden="true" /> {TEXTO_DOCTRINA}</footer>
    </div>
  );
}

export function OperatorWorkspace({ agents, adapters, access, topologyAccess, terminalCapability, terminalTargets, fleetLoading, fleetError, onSesionesAbiertas }: OperatorWorkspaceProps) {
  // La sesión que tiene el token CSRF en memoria: sin ella toda escritura del plano PTY vuelve 403.
  const api = useApi();
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [grants, setGrants] = useState<Record<string, TerminalSessionGrant>>({});
  const [closedChannels, setClosedChannels] = useState<Record<string, true>>({});
  const [plazas, setPlazas] = useState<TerminalSessionListItem[]>([]);
  const [plazasAlaVista, setPlazasAlaVista] = useState(0);
  const [topeAlcanzado, setTopeAlcanzado] = useState(false);
  const [motivoReconciliacionPlaza, setMotivoReconciliacionPlaza] = useState<MotivoReconciliacionPlaza>();
  const [revisandoPlazas, setRevisandoPlazas] = useState(false);
  const [cerrandoPlaza, setCerrandoPlaza] = useState<Record<string, true>>({});
  const [errorPlazas, setErrorPlazas] = useState<string>();
  /**
   * Synchronous tab-incarnation fence. State updates are intentionally not the authority here:
   * a 201 may resolve in the same turn as the click that closes its tab.
   */
  const sessionTokensRef = useRef(new Map<string, number>());
  const nextSessionTokenRef = useRef(0);
  const workspaceMountedRef = useRef(true);
  /** One reservation attempt per logical tab, even while its visible SessionStage is unmounted. */
  const terminalAttemptsRef = useRef(new Map<string, WorkspaceTerminalAttempt>());
  /** Stable request/capability for exact retries during one logical tab incarnation. */
  const terminalIntentsRef = useRef(new Map<string, WorkspaceTerminalIntent>());

  /*
   * LA SESIÓN NO PUEDE SOBREVIVIR A LA VISTA QUE LA ABRIÓ.
   *
   *  abrir la TUI de
   * dos alias y navegar a Portada dejaba `.terminal-session-head` = 0 y `.pty-host` = 2 nodos
   * VIVOS colgando del `<body>`, con sus dos sockets abiertos y sus dos filas `active` en
   * `terminal_sessions`. El tercer alias devolvía 409 `session_limit`. Al desmontar, este
   * componente perdía el mapa de `grants`, así que ni siquiera quedaba manera de soltarlas.
   *
   * El `ref` es imprescindible: la limpieza de un `useEffect` con lista vacía captura el valor
   * del PRIMER render, y en el primer render no hay un solo grant. Sin él la limpieza sería una
   * prueba que no puede dar rojo: correría siempre sobre un objeto vacío.
   */
  const grantsRef = useRef(grants);
  grantsRef.current = grants;
  const apiRef = useRef(api);
  apiRef.current = api;
  /** Sólo la lectura más nueva puede publicar estado; la inicial y la causal pueden solaparse. */
  const revisionPlazasRef = useRef(0);

  useEffect(() => {
    const sessionTokens = sessionTokensRef.current;
    const terminalIntents = terminalIntentsRef.current;
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      sessionTokens.clear();
      terminalIntents.clear();
      for (const grant of Object.values(grantsRef.current)) {
        closePtySession(grant.session_id, 'la vista de terminal se cerró');
        // El DELETE puede fallar (la vista se está yendo); el socket local ya se cortó igual, y el
        // relay cierra la fila del servidor en cuanto se le cae el navegador.
        void deleteTerminalSession(grant.session_id, grant, apiRef.current).catch(() => undefined);
      }
    };
  }, []);

  const revisarPlazas = useCallback(async () => {
    const revision = ++revisionPlazasRef.current;
    setRevisandoPlazas(true);
    try {
      const items = await listTerminalSessions(apiRef.current);
      if (revision !== revisionPlazasRef.current) return;
      const propias = Object.values(grantsRef.current).map((grant) => grant.session_id);
      const ocupadas = plazasOcupadas(items);
      const colgadas = plazasColgadas(items, propias);
      setPlazas(colgadas);
      setPlazasAlaVista(ocupadas.length - colgadas.length);
      setErrorPlazas(undefined);
    } catch (error) {
      if (revision !== revisionPlazasRef.current) return;
      // El último inventario verificable puede seguir orientando, pero jamás se presenta como
      // estado actual ni se convierte un fallo de lectura en «cero sesiones».
      const detail = error instanceof Error ? error.message : 'El gateway no devolvió un inventario verificable.';
      setErrorPlazas(`No se pudo verificar el inventario de sesiones PTY: ${detail}`);
    } finally {
      if (revision === revisionPlazasRef.current) setRevisandoPlazas(false);
    }
  }, []);

  useEffect(() => { void revisarPlazas(); }, [revisarPlazas]);

  async function cerrarPlaza(id: string) {
    setCerrandoPlaza((current) => ({ ...current, [id]: true }));
    try {
      const visible = plazas.find((item) => item.session_id === id);
      if (!visible) throw new Error('la sesión ya no pertenece al inventario visible');
      const ownerToken = terminalCapabilityUuid();
      const owner = await rotateTerminalSessionOwner(
        id,
        { request_id: visible.request_id, owner_generation: visible.owner_generation },
        ownerToken,
        apiRef.current,
      );
      await deleteTerminalSession(id, owner, apiRef.current);
      setPlazas((current) => current.filter((item) => item.session_id !== id));
      setTopeAlcanzado(false);
      setMotivoReconciliacionPlaza(undefined);
    } catch {
      // Se relee: si el servidor ya no la tiene, desaparece sola de la lista.
      await revisarPlazas();
    } finally {
      setCerrandoPlaza((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  const avisarRef = useRef(onSesionesAbiertas);
  avisarRef.current = onSesionesAbiertas;
  useEffect(() => { avisarRef.current?.(sessions.length); }, [sessions.length]);

  const liveSessions = sessions.map((session) => ({
    ...session,
    agent: agents.find((agent) => agent.id === session.agent.id) ?? session.agent,
  }));
  const activeSession = liveSessions.find((session) => session.id === activeId);

  function openAgent(agent: FleetAgent) {
    const id = sessionId(agent);
    if (!sessionTokensRef.current.has(id)) {
      sessionTokensRef.current.set(id, ++nextSessionTokenRef.current);
    }
    const sourceRoomId = operatorRouteForAgent(topologyAccess, access, agent).sourceRoomIds[0] ?? '';
    setSessions((current) => {
      const existing = current.find((session) => session.id === id);
      if (!existing) return [...current, createSession(agent, sourceRoomId)];
      if (!sourceRoomId || existing.sourceRoomId === sourceRoomId) return current;
      return current.map((session) => session.id === id ? { ...session, sourceRoomId } : session);
    });
    setActiveId(id);
  }

  function requestTerminalGrant(
    id: string,
    sessionToken: number,
    input: Omit<CreateTerminalSessionInput, 'request_id' | 'owner_token'>,
  ): Promise<TerminalGrantRequestOutcome> {
    if (!workspaceMountedRef.current || sessionTokensRef.current.get(id) !== sessionToken) {
      return Promise.reject(new TerminalApiError(
        'La pestaña que pidió el canal PTY ya no está abierta.', 409, 'stale_terminal_tab',
      ));
    }
    const inputKey = terminalRequestInputKey(input);
    let intent = terminalIntentsRef.current.get(id);
    if (intent === undefined || intent.sessionToken !== sessionToken || intent.inputKey !== inputKey) {
      intent = {
        sessionToken,
        inputKey,
        requestId: terminalCapabilityUuid(),
        ownerToken: terminalCapabilityUuid(),
      };
      terminalIntentsRef.current.set(id, intent);
    }
    const existing = terminalAttemptsRef.current.get(id);
    if (existing && existing.sessionToken === sessionToken) {
      if (existing.inputKey !== inputKey) {
        return Promise.reject(new TerminalApiError(
          'Ya hay otra reserva PTY en curso para esta pestaña.', 409, 'request_in_flight',
        ));
      }
      // Re-mounting the same tab adopts the exact promise; it never emits another POST.
      existing.subscribers.add(sessionToken);
      return existing.promise;
    }

    const subscribers = new Set([sessionToken]);
    const attemptId = Symbol('terminal-request-attempt');
    const command: CreateTerminalSessionInput = {
      ...input,
      request_id: intent.requestId,
      owner_token: intent.ownerToken,
    };
    const promise = createTerminalSession(command, apiRef.current).then(async (grant) => {
      const currentToken = sessionTokensRef.current.get(id);
      const canAdopt = workspaceMountedRef.current
        && currentToken !== undefined
        && subscribers.has(currentToken);
      const governedElsewhere = () => Object.values(grantsRef.current)
        .some((current) => current.session_id === grant.session_id);

      if (!canAdopt) {
        // A recovered lost-201 may name the same reservation a newer tab already governs. In that
        // case DELETE would revoke the live tab; otherwise this exact validated grant is ours to
        // compensate. Malformed payload IDs never reach this branch.
        if (!governedElsewhere()) {
          await deleteTerminalSession(grant.session_id, grant, apiRef.current).catch(() => undefined);
        }
        return { grant, adopted: false };
      }

      const current = grantsRef.current[id];
      if (current && current.session_id !== grant.session_id) {
        if (!governedElsewhere()) {
          await deleteTerminalSession(grant.session_id, grant, apiRef.current).catch(() => undefined);
        }
        return { grant, adopted: false };
      }
      const next = { ...grantsRef.current, [id]: grant };
      grantsRef.current = next;
      setGrants(next);
      setTopeAlcanzado(false);
      setMotivoReconciliacionPlaza(undefined);
      setClosedChannels((channels) => {
        if (channels[id] === undefined) return channels;
        const open = { ...channels };
        delete open[id];
        return open;
      });
      setSessions((currentSessions) => currentSessions.map((session) => session.id === id
        ? { ...session, mode: 'pty', channelMode: input.mode, liveTuiAttempted: true }
        : session));
      return { grant, adopted: true };
    }).finally(() => {
      if (terminalAttemptsRef.current.get(id)?.id === attemptId) terminalAttemptsRef.current.delete(id);
    });
    // A closed-and-reopened alias has another sessionToken and therefore replaces the registry
    // entry while the old promise finishes independently. Its continuation is fenced by both
    // token and attempt id, so it can only compensate its own exact owner capability.
    const attempt: WorkspaceTerminalAttempt = {
      id: attemptId, sessionToken, inputKey, subscribers, promise,
    };
    terminalAttemptsRef.current.set(id, attempt);
    return promise;
  }

  async function releaseChannel(id: string) {
    const grant = grantsRef.current[id];
    if (!grant) return;
    const remaining = { ...grantsRef.current };
    terminalIntentsRef.current.delete(id);
    delete remaining[id];
    grantsRef.current = remaining;
    setGrants(remaining);
    closePtySession(grant.session_id);
    try {
      await deleteTerminalSession(grant.session_id, grant, api);
    } catch {
      // The socket still has to go: a client-side failure must not leave a shell attached here.
    } finally {
      setClosedChannels((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  function closeSession(id: string) {
    // Cerrar una pestaña libera una plaza: el cartel del tope deja de tener razón de ser.
    setTopeAlcanzado(false);
    setMotivoReconciliacionPlaza(undefined);
    // Invalidate synchronously, before React commits the unmount. A late 201 cannot re-open this
    // incarnation even if its promise continuation runs in the same event-loop turn.
    sessionTokensRef.current.delete(id);
    terminalIntentsRef.current.delete(id);
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
    <>
      <PlazasColgadas
        items={plazas}
        aLaVista={plazasAlaVista}
        topeAlcanzado={topeAlcanzado}
        motivo={motivoReconciliacionPlaza}
        revisando={revisandoPlazas}
        cerrando={cerrandoPlaza}
        error={errorPlazas}
        onRevisar={() => { void revisarPlazas(); }}
        onCerrar={(id) => { void cerrarPlaza(id); }}
      />
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
        sessionTokens={sessionTokensRef.current}
        activeId={activeId}
        agents={agents}
        access={access}
        topologyAccess={topologyAccess}
        capability={terminalCapability}
        targets={terminalTargets}
        grants={grants}
        closedChannels={closedChannels}
        onActivate={setActiveId}
        onClose={closeSession}
        onUpdate={updateSession}
        onRequestGrant={requestTerminalGrant}
        onChannelClosed={(id) => setClosedChannels((current) => ({ ...current, [id]: true }))}
        onReleaseChannel={releaseChannel}
        onReconciliarPlazas={(motivo) => {
          setTopeAlcanzado(true);
          setMotivoReconciliacionPlaza(motivo);
          void revisarPlazas();
        }}
      />
      <aside className="terminal-control-inspector" aria-label="Estado del control plane">
        <AdapterInspector adapters={adapters} access={access} capability={terminalCapability} />
      </aside>
      </div>
      {/*
        La misma información que la columna de la derecha, para cuando esa columna no cabe (por
        debajo de 1400 px). Vive FUERA de la rejilla de sesiones a propósito: estaba dentro, y
        `GridContainer` corta antes cuando no hay ninguna sesión abierta — así que en un portátil
        recién entrado a la vista el estado del control plane no existía en ninguna parte de la
        página. Un panel que sólo aparece si ya hiciste clic en algo no está disponible.
      */}
      <div className="terminal-adapter-mobile" aria-label="Estado del control plane">
        <AdapterInspector adapters={adapters} access={access} capability={terminalCapability} />
      </div>
    </>
  );
}

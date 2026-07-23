import { lazy, Suspense, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  Bot,
  Braces,
  ChevronDown,
  CircleOff,
  Clock3,
  LockKeyhole,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useApi } from '../../api/context';
import type { AdapterView, ConsoleAccess, DeliveryView, TerminalCapability, TopologySnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { compactId, createId, permissionState } from '../../lib';
import { AckInspector } from './AckInspector';
import { FleetSidebar } from './FleetSidebar';
import type { FleetAgent } from './fleet';
import { terminalTargetMatchesAgent } from './fleet';
import { ultimateTerminalGate } from './plugin';
import { operatorRouteForAgent, sessionDeliveries, transcriptForSession, type OperatorSession } from './session';
import { TerminalTranscript } from './TerminalTranscript';

const PtyTerminal = lazy(() => import('./PtyTerminal'));

interface OperatorWorkspaceProps {
  agents: FleetAgent[];
  adapters: AdapterView[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  terminalCapability?: TerminalCapability;
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
        <p className="inspector-footnote">Solo se habilita si el target declarado coincide exactamente con el agente activo.</p>
      </section>
    </>
  );
}

function SessionStage({ sessions, activeId, agents, adapters, access, topologyAccess, capability, onActivate, onClose, onUpdate }: {
  sessions: OperatorSession[];
  activeId?: string;
  agents: FleetAgent[];
  adapters: AdapterView[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onUpdate: (session: OperatorSession) => void;
}) {
  const api = useApi();
  const messages = useResource('terminal-message-feed', () => api.listMessages());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedDeliveries, setSelectedDeliveries] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string }>();

  useEffect(() => {
    if (messages.loading) return;
    const interval = window.setInterval(messages.reload, 2_500);
    return () => window.clearInterval(interval);
  }, [messages.loading, messages.reload]);

  const storedSession = sessions.find((session) => session.id === activeId);
  const currentAgent = storedSession ? agents.find((agent) => agent.id === storedSession.agent.id) ?? storedSession.agent : undefined;
  const session = storedSession && currentAgent ? { ...storedSession, agent: currentAgent } : undefined;
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
  const ptyGate = ultimateTerminalGate(capability, access);
  const ptyMatches = session ? terminalTargetMatchesAgent(capability?.target_label, session.agent) : false;

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
                   <button type="button" aria-pressed={session.mode === 'pty'} data-active={session.mode === 'pty' || undefined} disabled={!ptyGate.enabled || !ptyMatches} onClick={() => onUpdate({ ...session, mode: 'pty' })} title={!ptyGate.enabled ? ptyGate.reason : !ptyMatches ? 'El target PTY no coincide con este agente' : undefined}><TerminalSquare size={14} aria-hidden="true" /> PTY</button>
                </div>
              </div>
            </header>

            <div className="terminal-connection-bar" role="status">
              <span className={`connection-dot ${messages.error ? 'error' : messages.data ? 'open' : 'connecting'}`} aria-hidden="true" />
              <strong>{messages.error ? 'FEED DEGRADADO' : messages.data ? 'POLLING ACTIVO' : 'CONECTANDO'}</strong>
              <span>{messages.error?.message ?? 'deliveries + ACK cada 2.5 s'}</span>
              <button type="button" onClick={messages.reload} disabled={messages.loading}><RefreshCw size={13} aria-hidden="true" /> Sincronizar</button>
            </div>

            {session.mode === 'pty' ? (
               ptyGate.enabled && ptyMatches && ptyGate.websocketPath ? (
                 <div className="terminal-pty-pane">
                   <div className="terminal-pty-warning"><TerminalSquare size={15} aria-hidden="true" /> Canal PTY server-declared para <strong>{capability?.target_label}</strong>. La UI solo transporta bytes.</div>
                   <Suspense fallback={<LoadingState label="Cargando Xterm…" />}><PtyTerminal websocketPath={ptyGate.websocketPath} /></Suspense>
                </div>
              ) : <div className="terminal-channel-unavailable"><CircleOff aria-hidden="true" /><h3>PTY no vinculado a este agente</h3><p>{ptyGate.reason}</p></div>
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
    </div>
  );
}

export function OperatorWorkspace({ agents, adapters, access, topologyAccess, terminalCapability, fleetLoading, fleetError }: OperatorWorkspaceProps) {
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
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

  function closeSession(id: string) {
    const index = sessions.findIndex((session) => session.id === id);
    const next = sessions.filter((session) => session.id !== id);
    setSessions(next);
    if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id);
  }

  function updateSession(updated: OperatorSession) {
    setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
  }

  return (
    <div className="ultimate-terminal-shell">
      <FleetSidebar agents={agents} adapters={adapters} activeAgentId={activeSession?.agent.id} onOpenAgent={openAgent} loading={fleetLoading} error={fleetError} />
      <SessionStage
        sessions={liveSessions}
        activeId={activeId}
        agents={agents}
        adapters={adapters}
        access={access}
        topologyAccess={topologyAccess}
        capability={terminalCapability}
        onActivate={setActiveId}
        onClose={closeSession}
        onUpdate={updateSession}
      />
      <aside className="terminal-control-inspector" aria-label="Estado del control plane">
        <AdapterInspector adapters={adapters} access={access} capability={terminalCapability} />
      </aside>
    </div>
  );
}

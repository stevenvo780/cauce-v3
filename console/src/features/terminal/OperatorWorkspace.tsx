import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { AdapterView, ConsoleAccess, TerminalCapability, TopologySnapshot } from '../../api/types';
import { AdapterInspector } from './AdapterInspector';
import { FleetSidebar } from './FleetSidebar';
import { GridContainer } from './GridContainer';
import { PlazasColgadas, type MotivoReconciliacionPlaza } from './PlazasColgadas';
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
import { plazasColgadas, plazasOcupadas } from './plazas';
import type { FleetAgent } from './fleet';
import { closePtySession } from './pty-session';
import { operatorRouteForAgent, type OperatorSession } from './session';
import type { TerminalGrantRequestOutcome } from './types';

export interface OperatorWorkspaceProps {
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
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  throw new Error('Este navegador no ofrece UUID seguros para cercar la sesión PTY.');
}

function omitKey<T>(map: Record<string, T>, keyToOmit: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== keyToOmit) result[k] = v;
  }
  return result;
}

export function OperatorWorkspace({ agents, adapters, access, topologyAccess, terminalCapability, terminalTargets, fleetLoading, fleetError, onSesionesAbiertas }: OperatorWorkspaceProps) {
  // La sesión que tiene el token CSRF en memoria: sin ella toda escritura del plano PTY vuelve 403.
  const api = useApi();
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [grants, setGrants] = useState<Record<string, TerminalSessionGrant>>({});
  const [closedChannels, setClosedChannels] = useState<Record<string, true | undefined>>({});
  const [plazas, setPlazas] = useState<TerminalSessionListItem[]>([]);
  const [plazasAlaVista, setPlazasAlaVista] = useState(0);
  const [topeAlcanzado, setTopeAlcanzado] = useState(false);
  const [motivoReconciliacionPlaza, setMotivoReconciliacionPlaza] = useState<MotivoReconciliacionPlaza>();
  const [revisandoPlazas, setRevisandoPlazas] = useState(false);
  const [cerrandoPlaza, setCerrandoPlaza] = useState<Record<string, true>>({});
  const [errorPlazas, setErrorPlazas] = useState<string>();

  const sessionTokensRef = useRef(new Map<string, number>());
  const nextSessionTokenRef = useRef(0);
  const workspaceMountedRef = useRef(true);
  /** One reservation attempt per logical tab, even while its visible SessionStage is unmounted. */
  const terminalAttemptsRef = useRef(new Map<string, WorkspaceTerminalAttempt>());
  /** Stable request/capability for exact retries during one logical tab incarnation. */
  const terminalIntentsRef = useRef(new Map<string, WorkspaceTerminalIntent>());

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
      await revisarPlazas();
    } finally {
      setCerrandoPlaza((current) => omitKey(current, id));
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
    if (intent?.sessionToken !== sessionToken || intent.inputKey !== inputKey) {
      intent = {
        sessionToken,
        inputKey,
        requestId: terminalCapabilityUuid(),
        ownerToken: terminalCapabilityUuid(),
      };
      terminalIntentsRef.current.set(id, intent);
    }
    const existing = terminalAttemptsRef.current.get(id);
    if (existing?.sessionToken === sessionToken) {
      if (existing.inputKey !== inputKey) {
        return Promise.reject(new TerminalApiError(
          'Ya hay otra reserva PTY en curso para esta pestaña.', 409, 'request_in_flight',
        ));
      }
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
        if (!governedElsewhere()) {
          await deleteTerminalSession(grant.session_id, grant, apiRef.current).catch(() => undefined);
        }
        return { grant, adopted: false };
      }

      const current = grantsRef.current[id] as TerminalSessionGrant | undefined;
      if (current !== undefined && current.session_id !== grant.session_id) {
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
        if (!(id in channels)) return channels;
        return omitKey(channels, id);
      });
      setSessions((currentSessions) => currentSessions.map((session) => session.id === id
        ? { ...session, mode: 'pty', channelMode: input.mode, liveTuiAttempted: true }
        : session));
      return { grant, adopted: true };
    }).finally(() => {
      if (terminalAttemptsRef.current.get(id)?.id === attemptId) terminalAttemptsRef.current.delete(id);
    });

    const attempt: WorkspaceTerminalAttempt = {
      id: attemptId, sessionToken, inputKey, subscribers, promise,
    };
    terminalAttemptsRef.current.set(id, attempt);
    return promise;
  }

  async function releaseChannel(id: string) {
    const grant = grantsRef.current[id] as TerminalSessionGrant | undefined;
    if (!grant) return;
    terminalIntentsRef.current.delete(id);
    const remaining = omitKey(grantsRef.current, id);
    grantsRef.current = remaining;
    setGrants(remaining);
    closePtySession(grant.session_id);
    try {
      await deleteTerminalSession(grant.session_id, grant, api);
    } catch {
      // The socket still has to go: a client-side failure must not leave a shell attached here.
    } finally {
      setClosedChannels((current) => omitKey(current, id));
    }
  }

  function closeSession(id: string) {
    setTopeAlcanzado(false);
    setMotivoReconciliacionPlaza(undefined);
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
        onChannelClosed={(id) => { setClosedChannels((current) => ({ ...current, [id]: true })); }}
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
      <div className="terminal-adapter-mobile" aria-label="Estado del control plane">
        <AdapterInspector adapters={adapters} access={access} capability={terminalCapability} />
      </div>
    </>
  );
}

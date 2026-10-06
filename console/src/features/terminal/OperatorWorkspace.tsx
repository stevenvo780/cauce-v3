import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConsoleAccess, MessagePage, TerminalCapability } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import type { LiveAgentView } from '../live/agent-state';
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
import { agentLiveState, type FleetAgent } from './fleet';
import { PlazasColgadas, type MotivoReconciliacionPlaza } from './PlazasColgadas';
import { plazasColgadas, plazasOcupadas } from './plazas';
import { closePtySession } from './pty-session';
import { SessionStage } from './SessionStage';
import { TerminalHome } from './TerminalHome';
import type { StageMemory, TerminalGrantRequestOutcome } from './types';

interface OperatorWorkspaceProps {
  agents: FleetAgent[];
  /** Agent named by the address; absent on the bare route, which shows the picker. */
  agentId?: string;
  live: ReadonlyMap<string, LiveAgentView>;
  messages: Resource<MessagePage>;
  summary: string;
  access?: ConsoleAccess;
  terminalCapability?: TerminalCapability;
  /** Optional: without the server inventory every destination stays UNKNOWN and PTY is closed. */
  terminalTargets?: TerminalTargetsSnapshot;
  fleetLoading: boolean;
  fleetError?: Error;
  onRefresh: () => void;
}

function sessionIdOf(agentId: string): string {
  return `session:${agentId}`;
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
    input.tenant_id, input.alias, input.mode, input.cols, input.rows,
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

export function OperatorWorkspace({ agents, agentId, live, messages, summary, access, terminalCapability, terminalTargets, fleetLoading, fleetError, onRefresh }: OperatorWorkspaceProps) {
  // The session that holds the CSRF token in memory: without it every PTY plane write returns 403.
  const api = useApi();
  const [grants, setGrants] = useState<Record<string, TerminalSessionGrant>>({});
  const [closedChannels, setClosedChannels] = useState<Record<string, true | undefined>>({});
  const [revocationFailures, setRevocationFailures] = useState<Record<string, true | undefined>>({});
  const [memory, setMemory] = useState<Record<string, StageMemory>>({});
  const [plazas, setPlazas] = useState<TerminalSessionListItem[]>([]);
  const [plazasAlaVista, setPlazasAlaVista] = useState(0);
  const [topeAlcanzado, setTopeAlcanzado] = useState(false);
  const [motivoReconciliacionPlaza, setMotivoReconciliacionPlaza] = useState<MotivoReconciliacionPlaza>();
  const [revisandoPlazas, setRevisandoPlazas] = useState(false);
  const [cerrandoPlaza, setCerrandoPlaza] = useState<Record<string, true>>({});
  const [errorCierrePlaza, setErrorCierrePlaza] = useState<string>();
  const [errorPlazas, setErrorPlazas] = useState<string>();

  const sessionTokensRef = useRef(new Map<string, number>());
  const nextSessionTokenRef = useRef(0);
  const workspaceMountedRef = useRef(true);
  /** One reservation attempt per opening, even while its visible SessionStage is unmounted. */
  const terminalAttemptsRef = useRef(new Map<string, WorkspaceTerminalAttempt>());
  /** Stable request/capability for exact retries during one opening. */
  const terminalIntentsRef = useRef(new Map<string, WorkspaceTerminalIntent>());

  const grantsRef = useRef(grants);
  grantsRef.current = grants;
  const apiRef = useRef(api);
  apiRef.current = api;
  /** Only the newest read may publish state; the initial and the causal ones may overlap. */
  const revisionPlazasRef = useRef(0);
  const releaseChannelRef = useRef<(id: string) => Promise<void>>(async () => undefined);

  const agent = agentId ? agents.find((item) => item.id === agentId) : undefined;
  const sessionId = agentId ? sessionIdOf(agentId) : undefined;

  // Each time the open agent changes it is a new incarnation: a reservation still in flight for the
  // previous one must not be adopted, and the token is what tells them apart.
  const openingRef = useRef<{ id?: string; token: number }>({ token: 0 });
  if (openingRef.current.id !== sessionId) {
    openingRef.current = { id: sessionId, token: ++nextSessionTokenRef.current };
    if (sessionId) sessionTokensRef.current.set(sessionId, openingRef.current.token);
  }

  useEffect(() => {
    const sessionTokens = sessionTokensRef.current;
    const terminalIntents = terminalIntentsRef.current;
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      sessionTokens.clear();
      terminalIntents.clear();
      for (const grant of Object.values(grantsRef.current)) {
        void deleteTerminalSession(grant.session_id, grant, apiRef.current)
          .catch(() => undefined)
          .finally(() => { closePtySession(grant.session_id, 'la vista de terminal se cerró'); });
      }
    };
  }, []);

  // Leaving an agent revokes its channel; if the gateway does not confirm, the notice stays with a retry.
  useEffect(() => {
    if (!sessionId) return;
    const sessionTokens = sessionTokensRef.current;
    const terminalIntents = terminalIntentsRef.current;
    const token = openingRef.current.token;
    sessionTokens.set(sessionId, token);
    return () => {
      if (sessionTokens.get(sessionId) === token) sessionTokens.delete(sessionId);
      terminalIntents.delete(sessionId);
      setTopeAlcanzado(false);
      setMotivoReconciliacionPlaza(undefined);
      // On unmount the effect above already revokes every grant; asking twice would double the DELETE.
      if (!workspaceMountedRef.current) return;
      setMemory((current) => omitKey(current, sessionId));
      void releaseChannelRef.current(sessionId);
    };
  }, [sessionId]);

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
    setErrorCierrePlaza(undefined);
    setCerrandoPlaza((current) => ({ ...current, [id]: true }));
    try {
      const visible = plazas.find((item) => item.session_id === id);
      if (!visible) throw new Error('la sesión ya no pertenece al inventario visible');
      const original = Object.values(grantsRef.current).find((grant) => grant.session_id === id);
      if (original?.request_id !== visible.request_id) {
        throw new TerminalApiError(
          'No se puede tomar una sesión colgada sin la prueba de autoridad original que conserva en memoria su pestaña.',
          409,
          'missing_authority_proof',
        );
      }
      const ownerToken = terminalCapabilityUuid();
      const owner = await rotateTerminalSessionOwner(
        id,
        { request_id: visible.request_id, owner_generation: visible.owner_generation,
          authority_proof: original.authority_proof },
        ownerToken,
        apiRef.current,
      );
      await deleteTerminalSession(id, owner, apiRef.current);
      setPlazas((current) => current.filter((item) => item.session_id !== id));
      setTopeAlcanzado(false);
      setMotivoReconciliacionPlaza(undefined);
    } catch (error) {
      if (error instanceof TerminalApiError && error.code === 'missing_authority_proof') {
        setErrorCierrePlaza('Esta pestaña no conserva la prueba original para cerrar esa sesión. Volvé a la pestaña que la abrió o esperá a que venza.');
      }
      await revisarPlazas();
    } finally {
      setCerrandoPlaza((current) => omitKey(current, id));
    }
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
      setMemory((current) => ({ ...current, [id]: { ...current[id], channelMode: input.mode, liveTuiAttempted: true } }));
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
    let revoked = false;
    try {
      await deleteTerminalSession(grant.session_id, grant, api);
      revoked = true;
      terminalIntentsRef.current.delete(id);
      const remaining = omitKey(grantsRef.current, id);
      grantsRef.current = remaining;
      setGrants(remaining);
      setRevocationFailures((current) => omitKey(current, id));
    } catch {
      setRevocationFailures((current) => ({ ...current, [id]: true }));
    } finally {
      closePtySession(grant.session_id);
      setClosedChannels((current) => revoked ? omitKey(current, id) : ({ ...current, [id]: true }));
    }
  }

  releaseChannelRef.current = releaseChannel;

  return (
    <>
      {Object.keys(revocationFailures).map((id) => {
        const grant = grantsRef.current[id] as TerminalSessionGrant | undefined;
        if (!grant) return null;
        return (
          <div role="alert" key={id} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">
            <AlertTriangle size={15} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1">No se confirmó la revocación de la sesión PTY. El canal local se cerró; vuelve a intentarlo.</span>
            <button type="button" className="button small secondary" onClick={() => { void releaseChannel(id); }}>Reintentar revocación</button>
          </div>
        );
      })}
      <PlazasColgadas
        items={plazas}
        aLaVista={plazasAlaVista}
        topeAlcanzado={topeAlcanzado}
        motivo={motivoReconciliacionPlaza}
        revisando={revisandoPlazas}
        cerrando={cerrandoPlaza}
        error={errorPlazas}
        errorCierre={errorCierrePlaza}
        onRevisar={() => { void revisarPlazas(); }}
        onCerrar={(id) => { void cerrarPlaza(id); }}
      />
      <div className="flex min-h-0 flex-1 flex-col" data-objeto-principal="escenario">
        {agent && sessionId ? (
          <ErrorBoundary label="La terminal del agente" resetKey={sessionId}>
            <SessionStage
              key={sessionId}
              agent={agent}
              sessionId={sessionId}
              sessionToken={openingRef.current.token}
              state={agentLiveState(agent, live)}
              memory={memory[sessionId] ?? {}}
              access={access}
              capability={terminalCapability}
              targets={terminalTargets}
              messages={messages}
              summary={summary}
              grants={grants}
              closedChannels={closedChannels}
              onRequestGrant={requestTerminalGrant}
              onMemory={(patch) => { setMemory((current) => ({ ...current, [sessionId]: { ...current[sessionId], ...patch } })); }}
              onChannelClosed={(id) => { setClosedChannels((current) => ({ ...current, [id]: true })); }}
              onReleaseChannel={releaseChannel}
              onReconciliarPlazas={(motivo) => {
                setTopeAlcanzado(true);
                setMotivoReconciliacionPlaza(motivo);
                void revisarPlazas();
              }}
              onRefresh={onRefresh}
            />
          </ErrorBoundary>
        ) : (
          <TerminalHome
            agents={agents}
            live={live}
            access={access}
            capability={terminalCapability}
            targets={terminalTargets}
            loading={fleetLoading}
            error={fleetError}
            summary={summary}
          />
        )}
      </div>
    </>
  );
}

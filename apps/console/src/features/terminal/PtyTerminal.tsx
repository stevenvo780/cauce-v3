import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  attachPtySession,
  detachPtySession,
  ensurePtySession,
  readPtySession,
  subscribePtySession,
  type PtySessionView,
} from './pty-session';

interface PtyTerminalProps {
  websocketPath: string;
  sessionId: string;
  /** Single-use, 30 s grant. It is held in memory only and never persisted. */
  ticket: string;
  onClosed?: (view: PtySessionView) => void;
  /** A new channel needs a new session: that re-runs authorisation and audit server-side. */
  onRequestNewSession?: () => void;
}

const STATE_LABELS: Readonly<Record<PtySessionView['state'], string>> = {
  connecting: 'CONECTANDO',
  attaching: 'AUTORIZANDO',
  open: 'ABIERTA',
  closed: 'CERRADA',
  error: 'ERROR',
};

/**
 * The component owns no terminal state: it lends a wrapper and the session manager reparents
 * the live node into it. Unmounting hides the terminal, it does not kill the session.
 */
export default function PtyTerminal({ websocketPath, sessionId, ticket, onClosed, onRequestNewSession }: PtyTerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  const subscribe = useCallback((listener: () => void) => subscribePtySession(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => readPtySession(sessionId), [sessionId]);
  const view = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    ensurePtySession({
      sessionId,
      websocketPath,
      ticket,
      onClosed: (closedView) => closedRef.current?.(closedView),
    });
  }, [sessionId, ticket, websocketPath]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    attachPtySession(sessionId, wrapper);
    return () => detachPtySession(sessionId);
  }, [sessionId]);

  const finished = view.state === 'closed' || view.state === 'error';
  return (
    <div className="pty-shell">
      <div className="pty-status" role="status">
        <span>
          <span className={`connection-dot ${view.state}`} aria-hidden="true" /> Conexión: {STATE_LABELS[view.state]}
          {view.message ? ` · ${view.message}` : ''}
          {view.closeCode !== undefined ? ` (código ${view.closeCode})` : ''}
        </span>
        {finished && onRequestNewSession ? (
          <button type="button" onClick={onRequestNewSession} title="El ticket es de un solo uso; se pide una sesión nueva con motivo y auditoría.">
            <KeyRound size={12} aria-hidden="true" /> Pedir sesión nueva
          </button>
        ) : null}
      </div>
      {view.renderError ? (
        <p className="pty-render-error" role="alert">Renderer del terminal degradado: {view.renderError}</p>
      ) : null}
      {view.notices.length ? (
        <ul className="pty-notices" aria-label="Avisos del relay">
          {view.notices.map((notice, index) => (
            <li key={`${notice.level}-${index}`} data-level={notice.level}>{notice.message}</li>
          ))}
        </ul>
      ) : null}
      <div ref={wrapperRef} className="pty-mount" data-session-id={sessionId} />
      {finished ? (
        <p className="pty-reconnect-note">
          El ticket ya se consumió. La consola no reconecta sola: abrir otro canal exige una sesión nueva, con su motivo y su registro de auditoría.
        </p>
      ) : null}
    </div>
  );
}

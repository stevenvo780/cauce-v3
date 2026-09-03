import { ArrowDownToLine, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  attachPtySession,
  detachPtySession,
  ensurePtySession,
  ptySessionVolverAlFinal,
  readPtySession,
  subscribePtySession,
  type PtySessionView,
} from './pty-session';
import { COLUMNAS_MINIMAS } from './pty-theme';

interface PtyTerminalProps {
  websocketPath: string;
  sessionId: string;
  /** Single-use, 30 s grant. It is held in memory only and never persisted. */
  ticket: string;
  /** Read-only observation of the agent's TUI: not a single keystroke is sent over this channel. */
  readOnly?: boolean;
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
 *
 * The layer order matters and it was wrong before.** The relay notices (`pty-notices`) and the
 * renderer error sat BETWEEN the status bar and the terminal, so every arriving notice pushed
 * the terminal down a few pixels and the text you were reading moved. Now the terminal fills
 * the gap (`flex: 1`) and everything accessory goes below, with a bounded height: what moves
 * is the secondary, not what you are reading.
 */
export default function PtyTerminal({ websocketPath, sessionId, ticket, readOnly, onClosed, onRequestNewSession }: PtyTerminalProps) {
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
      readOnly,
      onClosed: (closedView) => closedRef.current?.(closedView),
    });
  }, [readOnly, sessionId, ticket, websocketPath]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    attachPtySession(sessionId, wrapper);
    return () => { detachPtySession(sessionId); };
  }, [sessionId]);

  const finished = view.state === 'closed' || view.state === 'error';
  return (
    <div className="pty-shell" data-read-only={readOnly ? true : undefined} data-state={view.state}>
      <div className="pty-status" role="status">
        <span>
          <span className={`connection-dot ${view.state}`} aria-hidden="true" /> Conexión: {STATE_LABELS[view.state]}
          {readOnly ? ' · SOLO LECTURA' : ''}
          {view.message ? ` · ${view.message}` : ''}
          {view.closeCode !== undefined ? ` (código ${String(view.closeCode)})` : ''}
        </span>
        {finished && onRequestNewSession ? (
          <button type="button" onClick={onRequestNewSession} title="El ticket es de un solo uso; se pide una sesión nueva con motivo y auditoría.">
            <KeyRound size={12} aria-hidden="true" /> Pedir sesión nueva
          </button>
        ) : null}
      </div>
      {/*
        THE NARROW MIRROR MUST NOT GO SILENT. The agent now MEASURES its window and sends it in a
        GEOMETRY frame, so the console shrinks the body until that exact width fits instead of
        aiming at a hardcoded 80. This sign is what is left when not even the smallest body fits:
        what overflows to the right is not seen, and a view that hides it lies.
      */}
      {view.columnas !== undefined && view.columnas < (view.columnasRemotas ?? COLUMNAS_MINIMAS) ? (
        <p
          className="pty-estrecho"
          role="status"
          title={`La ventana del agente mide ${String(view.columnasRemotas ?? COLUMNAS_MINIMAS)} columnas y acá entran ${String(view.columnas)} incluso con el cuerpo más chico. Girá el teléfono o abrila en una pantalla más ancha.`}
        >
          Caben {String(view.columnas)} columnas y la TUI del agente mide {String(view.columnasRemotas ?? COLUMNAS_MINIMAS)}: se corta por la derecha.
        </p>
      ) : null}
      <div className="pty-viewport">
        <div ref={wrapperRef} className="pty-mount" data-session-id={sessionId} />
        {view.seguirAlFinal ? null : (
          <button
            className="pty-volver-al-final"
            type="button"
            onClick={() => { ptySessionVolverAlFinal(sessionId); }}
            title="Subiste a leer, así que la salida nueva no te arrastra. Esto vuelve al final y reengancha el seguimiento."
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Salida nueva abajo · volver al final
          </button>
        )}
      </div>
      {view.renderError ? (
        <p className="pty-render-error" role="alert">Renderer del terminal degradado: {view.renderError}</p>
      ) : null}
      {view.notices.length ? (
        <ul className="pty-notices" aria-label="Avisos del relay">
          {view.notices.map((notice, index) => (
            <li key={`${notice.level}-${String(index)}`} data-level={notice.level}>{notice.message}</li>
          ))}
        </ul>
      ) : null}
      {finished ? (
        <p className="pty-reconnect-note">
          La consola sólo reanuda automáticamente una interrupción de transporte mientras el relay
          conserva el mismo PTY. Este cierre ya terminó el canal: abrir otro exige una sesión nueva
          y una nueva auditoría.
        </p>
      ) : null}
    </div>
  );
}

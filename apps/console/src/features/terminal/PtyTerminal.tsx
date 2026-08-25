import { ArrowDownToLine, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  attachPtySession,
  detachPtySession,
  ensurePtySession,
  PTY_COLUMNAS_MINIMAS,
  ptySessionVolverAlFinal,
  readPtySession,
  subscribePtySession,
  type PtySessionView,
} from './pty-session';

interface PtyTerminalProps {
  websocketPath: string;
  sessionId: string;
  /** Single-use, 30 s grant. It is held in memory only and never persisted. */
  ticket: string;
  /** Observación de la TUI del agente: no se manda una sola tecla por este canal. */
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
 * 🔴 **El orden de las capas importa y antes estaba mal.** Los avisos del relay (`pty-notices`) y
 * el error de renderer iban ENTRE la barra de estado y el terminal, así que cada aviso que llegaba
 * empujaba el terminal hacia abajo unos píxeles y el texto que estabas leyendo se movía. Ahora el
 * terminal ocupa el hueco (`flex: 1`) y todo lo accesorio va debajo, con alto acotado: lo que se
 * mueve es lo secundario, no lo que estás leyendo.
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
    return () => detachPtySession(sessionId);
  }, [sessionId]);

  const finished = view.state === 'closed' || view.state === 'error';
  return (
    <div className="pty-shell" data-read-only={readOnly || undefined} data-state={view.state}>
      <div className="pty-status" role="status">
        <span>
          <span className={`connection-dot ${view.state}`} aria-hidden="true" /> Conexión: {STATE_LABELS[view.state]}
          {readOnly ? ' · SOLO LECTURA' : ''}
          {view.message ? ` · ${view.message}` : ''}
          {view.closeCode !== undefined ? ` (código ${view.closeCode})` : ''}
        </span>
        {finished && onRequestNewSession ? (
          <button type="button" onClick={onRequestNewSession} title="El ticket es de un solo uso; se pide una sesión nueva con motivo y auditoría.">
            <KeyRound size={12} aria-hidden="true" /> Pedir sesión nueva
          </button>
        ) : null}
      </div>
      {/*
        🔴 EL ESPEJO ESTRECHO NO PUEDE CALLARSE. El agente PTY se engancha a la tmux del alias con
        `attach-session -r -f ignore-size`: la ventana remota conserva SU ancho pase lo que pase
        (y menos mal — redimensionar la tmux de un agente que está trabajando sería tocarle el
        escritorio). Si acá caben menos columnas que allá, lo que sobra por la derecha no se ve.
        Medido a 360x800 antes de esto: `"tenan`, `"socr`, `mes` — líneas partidas contra el borde,
        sin barra de desplazamiento y sin una palabra que lo dijera. Eso es una vista que miente.
      */}
      {view.columnas !== undefined && view.columnas < PTY_COLUMNAS_MINIMAS ? (
        <p
          className="pty-estrecho"
          role="status"
          title={`El agente PTY se engancha a la tmux del alias en solo lectura y sin participar del tamaño de la ventana (attach-session -r -f ignore-size), así que la ventana remota conserva su ancho y no se adapta a esta pantalla. Caben ${view.columnas} columnas. Girá el teléfono o abrila en una pantalla más ancha.`}
        >
          Caben {view.columnas} columnas: la TUI del agente es más ancha y se corta por la derecha.
        </p>
      ) : null}
      <div className="pty-viewport">
        <div ref={wrapperRef} className="pty-mount" data-session-id={sessionId} />
        {view.seguirAlFinal ? null : (
          <button
            className="pty-volver-al-final"
            type="button"
            onClick={() => ptySessionVolverAlFinal(sessionId)}
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
            <li key={`${notice.level}-${index}`} data-level={notice.level}>{notice.message}</li>
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

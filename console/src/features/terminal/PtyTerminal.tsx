import { ArrowDownToLine, Eye, KeyRound } from 'lucide-react';
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
import { cn } from '../../cn';
import { COLUMNAS_MINIMAS } from './pty-theme';

interface PtyTerminalProps {
  websocketPath: string;
  sessionId: string;
  /** Single-use, 30 s grant. It is held in memory only and never persisted. */
  ticket: string;
  authorityProof: string;
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

const DOT_CLASS: Readonly<Record<PtySessionView['state'], string>> = {
  connecting: 'bg-warn',
  attaching: 'bg-warn',
  open: 'bg-ok',
  closed: 'bg-danger',
  error: 'bg-danger',
};

/** The terminal surface is dark in both themes; its chrome is a translucent veil over it. */
const STRIP = 'flex-none border-white/10 px-3 py-1 text-xs';

/**
 * The component owns no terminal state: it lends a wrapper and the session manager reparents the
 * live node into it. Unmounting hides the terminal, it does not kill the session.
 *
 * The terminal fills the gap and everything accessory goes below it with a bounded height, so an
 * arriving notice never pushes the text being read.
 */
export default function PtyTerminal({ websocketPath, sessionId, ticket, authorityProof, readOnly, onClosed, onRequestNewSession }: PtyTerminalProps) {
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
      authorityProof,
      readOnly,
      onClosed: (closedView) => closedRef.current?.(closedView),
    });
  }, [authorityProof, readOnly, sessionId, ticket, websocketPath]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    attachPtySession(sessionId, wrapper);
    return () => { detachPtySession(sessionId); };
  }, [sessionId]);

  const finished = view.state === 'closed' || view.state === 'error';
  const label = STATE_LABELS[view.state];
  return (
    <div className="pty-surface flex min-h-0 flex-1 flex-col" data-pty-shell="" data-read-only={readOnly ? true : undefined} data-state={view.state}>
      {/* The agent measures its window and the console shrinks the body until that width fits;
          this sign is what is left when not even the smallest body does. */}
      {view.columnas !== undefined && view.columnas < (view.columnasRemotas ?? COLUMNAS_MINIMAS) ? (
        <p
          className={cn(STRIP, 'm-0 truncate border-b bg-warn/15 text-warn-ink')}
          role="status"
          title={`La ventana del agente mide ${String(view.columnasRemotas ?? COLUMNAS_MINIMAS)} columnas y acá entran ${String(view.columnas)} incluso con el cuerpo más chico. Girá el teléfono o abrila en una pantalla más ancha.`}
        >
          Caben {String(view.columnas)} columnas y la TUI del agente mide {String(view.columnasRemotas ?? COLUMNAS_MINIMAS)}: se corta por la derecha.
        </p>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          ref={wrapperRef}
          data-session-id={sessionId}
          className="min-h-0 min-w-0 flex-1 overflow-hidden pt-1.5 pl-2 [&>.pty-host]:h-full [&_.xterm]:h-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-viewport]:[scrollbar-width:thin]"
        />
        {view.seguirAlFinal ? null : (
          <button
            type="button"
            onClick={() => { ptySessionVolverAlFinal(sessionId); }}
            title="Subiste a leer, así que la salida nueva no te arrastra. Esto vuelve al final y reengancha el seguimiento."
            className="absolute right-4 bottom-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/20 bg-black/70 px-3 py-1 text-xs text-white shadow-pop backdrop-blur hover:bg-black/80"
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Salida nueva abajo · volver al final
          </button>
        )}
      </div>
      {view.renderError ? (
        <p className={cn(STRIP, 'm-0 border-t bg-warn/15 text-warn-ink')} role="alert">Renderer del terminal degradado: {view.renderError}</p>
      ) : null}
      {view.notices.length ? (
        <ul className={cn(STRIP, 'm-0 grid max-h-20 list-none gap-0.5 overflow-y-auto border-t text-white/65')} aria-label="Avisos del relay">
          {view.notices.map((notice, index) => (
            <li key={`${notice.level}-${String(index)}`} data-level={notice.level}
              className={cn(notice.level === 'warn' && 'text-warn', notice.level === 'error' && 'text-danger')}>{notice.message}</li>
          ))}
        </ul>
      ) : null}
      {finished ? (
        <p className={cn(STRIP, 'm-0 border-t text-white/50')}>
          La consola sólo reanuda automáticamente una interrupción de transporte mientras el relay
          conserva el mismo PTY. Este cierre ya terminó el canal: abrir otro exige una sesión nueva
          y una nueva auditoría.
        </p>
      ) : null}
      <div className={cn(STRIP, 'flex items-center gap-2 border-t bg-white/5 text-white/60')} role="status">
        <span className="inline-flex items-center gap-1.5" title={`Conexión: ${label}`} aria-label={`Conexión: ${label}`}>
          <span className={cn('size-2 rounded-full', DOT_CLASS[view.state])} aria-hidden="true" />
          <span className="max-[760px]:sr-only" aria-hidden="true">{label.charAt(0) + label.slice(1).toLowerCase()}</span>
        </span>
        {readOnly ? (
          <span className="inline-flex items-center gap-1" title="Solo lectura" aria-label="Solo lectura">
            <Eye size={13} aria-hidden="true" /><span className="max-[760px]:sr-only" aria-hidden="true">Solo lectura</span>
          </span>
        ) : null}
        {view.message ? <span className="min-w-0 truncate">{view.message}{view.closeCode !== undefined ? ` (código ${String(view.closeCode)})` : ''}</span> : null}
        {finished && onRequestNewSession ? (
          <button
            type="button"
            onClick={onRequestNewSession}
            title="Abrir una sesión nueva"
            className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs font-medium text-flow hover:bg-white/10"
          >
            <KeyRound size={12} aria-hidden="true" /> Pedir sesión nueva
          </button>
        ) : null}
      </div>
    </div>
  );
}

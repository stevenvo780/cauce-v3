import { Container, Eye, Hourglass, Keyboard, MonitorPlay, TerminalSquare, Timer, UserCog } from 'lucide-react';
import type { TerminalSessionGrant } from './api';
import { LIVE_TUI_MODE, WRITABLE_TUI_MODE, type FleetAgent } from './fleet';
import { formatCountdown, ptySecondsLeft } from './session';

export function PtySessionBar({ agent, grant, secondsLeft, readOnly, ticketConsumed, ventanaHasta, prorrogando, onProrrogar }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  readOnly: boolean;
  ticketConsumed: boolean;
  ventanaHasta?: string;
  prorrogando: boolean;
  onProrrogar: () => void;
}) {
  const tui = grant.target.mode === LIVE_TUI_MODE || grant.target.mode === WRITABLE_TUI_MODE;
  const mode = tui ? 'TUI en vivo' : 'Terminal · shell nueva';
  const access = readOnly ? 'Solo lectura' : 'Control de teclado';
  const ticket = ticketConsumed ? 'Ticket consumido · sesión activa' : `Ticket vence en ${formatCountdown(secondsLeft)}`;
  return (
    <div className="pty-session-bar" aria-label="Sesión PTY activa" data-read-only={readOnly || undefined}>
      <span className="terminal-status-icon" title={`${agent.tenantId}/${agent.alias}: ${mode}`} aria-label={mode}>
        {tui ? <MonitorPlay size={15} aria-hidden="true" /> : <TerminalSquare size={15} aria-hidden="true" />}
      </span>
      <span className="terminal-status-icon" title={access} aria-label={access}>
        {readOnly ? <Eye size={15} aria-hidden="true" /> : <Keyboard size={15} aria-hidden="true" />}
      </span>
      <span className="terminal-status-icon" title={`Contenedor: ${grant.target.container ?? 'sin dato'}`}
        aria-label={`Contenedor: ${grant.target.container ?? 'sin dato'}`}><Container size={15} aria-hidden="true" /></span>
      <span className="terminal-status-icon" title={`Usuario destino: ${grant.target.runtime_user ?? 'sin dato'}`}
        aria-label={`Usuario destino: ${grant.target.runtime_user ?? 'sin dato'}`}><UserCog size={15} aria-hidden="true" /></span>
      <span className="terminal-status-icon" title={ticket} aria-label={ticket}
        data-expiring={!ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10 || undefined}>
        <Timer size={15} aria-hidden="true" /><span className="sr-only">{ticket}</span>
      </span>
      {ventanaHasta ? <span className="terminal-status-icon" title={`Ventana restante: ${formatCountdown(ptySecondsLeft(ventanaHasta))}`}
        aria-label={`Ventana restante: ${formatCountdown(ptySecondsLeft(ventanaHasta))}`}>
        <Hourglass size={15} aria-hidden="true" />
      </span> : null}
      <button className="button small secondary pty-bar-prorrogar" type="button" onClick={onProrrogar}
        disabled={prorrogando || !ticketConsumed} aria-label={prorrogando ? 'Prorrogando sesión' : 'Prorrogar sesión'}
        title={ticketConsumed ? 'Prorrogar la ventana de esta sesión con auditoría' : 'Disponible cuando el relay ya enganchó y consumió el ticket'}>
        <Hourglass size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

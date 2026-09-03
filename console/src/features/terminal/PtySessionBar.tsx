import {
  Braces,
  Container,
  Eye,
  Hourglass,
  MessageSquareText,
  MonitorPlay,
  PowerOff,
  TerminalSquare,
  Timer,
  UserCog,
} from 'lucide-react';
import { Unknown } from '../../components/ui';
import { compactId } from '../../lib';
import type { TerminalSessionGrant } from './api';
import { WRITABLE_TUI_MODE, type FleetAgent } from './fleet';
import { formatCountdown, ptySecondsLeft } from './session';

export function PtySessionBar({ agent, grant, secondsLeft, readOnly, ticketConsumed, feedEnPausa, closing, ventanaHasta, prorrogando, onProrrogar, onClose }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  readOnly: boolean;
  ticketConsumed: boolean;
  /** The durable feed stands down only while this channel is the live source. */
  feedEnPausa: boolean;
  closing: boolean;
  ventanaHasta?: string;
  prorrogando: boolean;
  onProrrogar: () => void;
  onClose: () => void;
}) {
  const sinTeclado = readOnly && grant.target.mode === WRITABLE_TUI_MODE;
  return (
    <div className="pty-session-bar" aria-label="Sesión PTY activa" data-read-only={readOnly || undefined}>
      <span className="pty-bar-alias">{readOnly ? <MonitorPlay size={14} aria-hidden="true" /> : <TerminalSquare size={14} aria-hidden="true" />} <strong>{agent.alias}</strong></span>
      {readOnly ? <span className="pty-bar-readonly"><Eye size={13} aria-hidden="true" /> {sinTeclado ? 'TUI con teclado · todavía sin el control' : 'TUI en vivo · solo lectura'}</span> : null}
      <span className="pty-bar-dato" title={grant.target.container ?? undefined}><Container size={13} aria-hidden="true" /> <span className="mono">{grant.target.container ? compactId(grant.target.container) : <Unknown value={grant.target.container} />}</span></span>
      <span className="pty-bar-dato"><UserCog size={13} aria-hidden="true" /> <span className="mono"><Unknown value={grant.target.runtime_user} /></span></span>
      <span className="pty-bar-dato"><Braces size={13} aria-hidden="true" /> <span className="mono">{grant.target.mode}</span></span>
      <span className="pty-bar-countdown" data-expiring={!ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10 ? 'true' : undefined}>
        <Timer size={13} aria-hidden="true" />
        {ticketConsumed
          ? <>Ticket consumido · <strong>sesión activa</strong></>
          : <>Ticket vence en <strong>{formatCountdown(secondsLeft)}</strong></>}
      </span>
      {ventanaHasta ? (
        <span className="pty-bar-ventana"><Hourglass size={13} aria-hidden="true" /> Ventana hasta <strong>{formatCountdown(ptySecondsLeft(ventanaHasta))}</strong></span>
      ) : null}
      <button
        className="button small secondary pty-bar-prorrogar"
        type="button"
        onClick={onProrrogar}
        disabled={prorrogando || !ticketConsumed}
        title={ticketConsumed
          ? 'Empuja la ventana de esta sesión. Es un acto explícito y auditado: nada la renueva sola.'
          : 'Todavía no: el gateway sólo prorroga una sesión que el relay ya enganchó. Esperá a que el ticket se consuma.'}
      >
        <Hourglass size={13} aria-hidden="true" /> {prorrogando ? 'Prorrogando…' : 'Prorrogar'}
      </button>
      <span className="pty-bar-feed"><MessageSquareText size={13} aria-hidden="true" /> {feedEnPausa ? 'POLLING EN PAUSA' : 'POLLING ACTIVO'}</span>
      <button className="button small secondary pty-bar-close" type="button" onClick={onClose} disabled={closing} title="Cierra el canal PTY de este alias. No cierra tu sesión de la consola.">
        <PowerOff size={13} aria-hidden="true" /> {closing ? 'Cerrando…' : 'Cerrar la terminal'}
      </button>
    </div>
  );
}

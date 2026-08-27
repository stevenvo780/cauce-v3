import {
  Braces,
  Container,
  Eye,
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
import type { FleetAgent } from './fleet';
import { formatCountdown } from './session';

export function PtySessionBar({ agent, grant, secondsLeft, readOnly, ticketConsumed, closing, onClose }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  readOnly: boolean;
  ticketConsumed: boolean;
  closing: boolean;
  onClose: () => void;
}) {
  return (
    <div className="pty-session-bar" aria-label="Sesión PTY activa" data-read-only={readOnly || undefined}>
      <span className="pty-bar-alias">{readOnly ? <MonitorPlay size={14} aria-hidden="true" /> : <TerminalSquare size={14} aria-hidden="true" />} <strong>{agent.alias}</strong></span>
      {readOnly ? <span className="pty-bar-readonly"><Eye size={13} aria-hidden="true" /> TUI en vivo · solo lectura</span> : null}
      <span className="pty-bar-dato" title={grant.target.container ?? undefined}><Container size={13} aria-hidden="true" /> <span className="mono">{grant.target.container ? compactId(grant.target.container) : <Unknown value={grant.target.container} />}</span></span>
      <span className="pty-bar-dato"><UserCog size={13} aria-hidden="true" /> <span className="mono"><Unknown value={grant.target.runtime_user} /></span></span>
      <span className="pty-bar-dato"><Braces size={13} aria-hidden="true" /> <span className="mono">{grant.target.mode}</span></span>
      <span className="pty-bar-countdown" data-expiring={!ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10 ? 'true' : undefined}>
        <Timer size={13} aria-hidden="true" />
        {ticketConsumed
          ? <>Ticket consumido · <strong>sesión activa</strong></>
          : <>Ticket vence en <strong>{formatCountdown(secondsLeft)}</strong></>}
      </span>
      <span className="pty-bar-feed"><MessageSquareText size={13} aria-hidden="true" /> POLLING EN PAUSA</span>
      <button className="button small secondary pty-bar-close" type="button" onClick={onClose} disabled={closing} title="Cierra el canal PTY de este alias. No cierra tu sesión de la consola.">
        <PowerOff size={13} aria-hidden="true" /> {closing ? 'Cerrando…' : 'Cerrar la terminal'}
      </button>
    </div>
  );
}

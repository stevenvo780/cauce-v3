import { Container, Eye, Hourglass, Keyboard, MonitorPlay, TerminalSquare, Timer, UserCog, type LucideIcon } from 'lucide-react';
import { cn } from '../../cn';
import type { TerminalSessionGrant } from './api';
import { LIVE_TUI_MODE, WRITABLE_TUI_MODE, type FleetAgent } from './fleet';
import { formatCountdown, ptySecondsLeft } from './session';

function Fact({ icon: Icon, label, title, className, words, expiring, children }: {
  icon: LucideIcon;
  label: string;
  title?: string;
  className?: string;
  words?: boolean;
  expiring?: boolean;
  children?: string;
}) {
  return (
    <span title={title ?? label} aria-label={label} data-expiring={expiring ? true : undefined} className={cn('inline-flex h-7 items-center gap-1 px-1.5 text-muted', className)}>
      <Icon size={14} aria-hidden="true" />
      {children ? <span className="text-xs tabular-nums" aria-hidden="true">{children}</span> : null}
      {words ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

/** What the open channel IS, as icons with their words in the tooltip: mode, keyboard, target, ticket. */
export function PtySessionBar({ agent, grant, secondsLeft, readOnly, ticketConsumed, ventanaHasta }: {
  agent: FleetAgent;
  grant: TerminalSessionGrant;
  secondsLeft?: number;
  readOnly: boolean;
  ticketConsumed: boolean;
  ventanaHasta?: string;
}) {
  const tui = grant.target.mode === LIVE_TUI_MODE || grant.target.mode === WRITABLE_TUI_MODE;
  const mode = tui ? 'TUI en vivo' : 'Terminal · shell nueva';
  const access = readOnly ? 'Solo lectura' : 'Control de teclado';
  const ticket = ticketConsumed ? 'Ticket consumido · sesión activa' : `Ticket vence en ${formatCountdown(secondsLeft)}`;
  const expiring = !ticketConsumed && secondsLeft !== undefined && secondsLeft <= 10;
  const container = `Contenedor: ${grant.target.container ?? 'sin dato'}`;
  const user = `Usuario destino: ${grant.target.runtime_user ?? 'sin dato'}`;
  const ventana = ventanaHasta ? `Ventana restante: ${formatCountdown(ptySecondsLeft(ventanaHasta))}` : undefined;
  return (
    <div role="group" aria-label="Sesión PTY activa" data-read-only={readOnly || undefined} className="flex items-center">
      <Fact icon={tui ? MonitorPlay : TerminalSquare} label={mode} title={`${agent.tenantId}/${agent.alias}: ${mode}`} className="max-[760px]:hidden" />
      <Fact icon={readOnly ? Eye : Keyboard} label={access} className={readOnly ? undefined : 'text-ok-ink'} />
      <Fact icon={Container} label={container} className="max-[760px]:hidden" />
      <Fact icon={UserCog} label={user} className="max-[760px]:hidden" />
      {ventana ? <Fact icon={Hourglass} label={ventana} /> : null}
      <Fact icon={Timer} label={ticket} className={cn(expiring && 'text-danger-ink')} expiring={expiring} words>
        {ticketConsumed ? undefined : formatCountdown(secondsLeft)}
      </Fact>
    </div>
  );
}

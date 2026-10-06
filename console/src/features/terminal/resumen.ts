import type { TerminalTarget } from './api';
import { countLiveTuiTargets, countOnlinePtyTargets, type FleetAgent } from './fleet';

/**
 * One-line fleet summary. A count the inventory does not back is left out, never shown as zero:
 * an unpublished inventory is UNKNOWN, not "no terminals".
 */
export function resumenDeFlota(agents: readonly FleetAgent[], targets: TerminalTarget[] | null | undefined): string {
  const enLinea = agents.filter((agent) => agent.leaseState === 'online').length;
  const tui = countLiveTuiTargets(targets);
  const terminal = countOnlinePtyTargets(targets);
  return [
    `${String(agents.length)} agente${agents.length === 1 ? '' : 's'}`,
    `${String(enLinea)} en línea`,
    tui === undefined ? undefined : `${String(tui)} con TUI`,
    terminal === undefined ? undefined : `${String(terminal)} con terminal`,
  ].filter(Boolean).join(' · ');
}

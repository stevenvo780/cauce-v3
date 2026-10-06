import type { TerminalTarget } from './api';
import type { FleetAgent } from './fleet';
import { resumenDeFlota } from './resumen';

function agent(alias: string, leaseState: FleetAgent['leaseState']): FleetAgent {
  return { id: `Steven:${alias}`, tenantId: 'Steven', alias, roomIds: [], roomMembership: {}, leaseState };
}

function target(alias: string, modes: string[]): TerminalTarget {
  return {
    tenant_id: 'Steven', alias, container: 'c', runtime_user: 'u', harness: null, shares_container_with: [],
    modes, pty_state: 'online', last_seen: null, authorized: true, reason: 'ok',
  };
}

it('cuenta agentes, presencia, TUI y terminal desde el inventario publicado', () => {
  const agents = [agent('kant', 'online'), agent('zeus', 'unknown'), agent('argos', 'expired')];
  const targets = [target('kant', ['shell', 'harness']), target('zeus', ['shell'])];
  expect(resumenDeFlota(agents, targets)).toBe('3 agentes · 1 en línea · 1 con TUI · 2 con terminal');
});

it('sin inventario no inventa ceros: omite TUI y terminal', () => {
  expect(resumenDeFlota([agent('kant', 'online')], null)).toBe('1 agente · 1 en línea');
});

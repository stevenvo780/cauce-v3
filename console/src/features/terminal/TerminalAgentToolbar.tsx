import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalTargetsSnapshot } from './api';
import { fleetTerminalChip, type FleetAgent } from './fleet';

export function TerminalAgentToolbar({ agents, activeId, targets, disabled, onSelect, children }: {
  agents: FleetAgent[];
  activeId?: string;
  targets?: TerminalTargetsSnapshot;
  disabled: boolean;
  onSelect: (agent: FleetAgent) => void;
  children?: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.getElementById('terminal-topbar-tools')); }, []);
  const tools = <div className="terminal-agent-toolbar">
    <label htmlFor="terminal-agent-select" className="sr-only">Agente</label>
    <select id="terminal-agent-select" value={activeId ?? ''} disabled={disabled}
      onChange={(event) => {
        const agent = agents.find((item) => item.id === event.target.value);
        if (agent) onSelect(agent);
      }}>
      <option value="">Elegir agente</option>
      {agents.map((agent) => {
        const state = fleetTerminalChip(targets?.items, agent);
        return <option key={agent.id} value={agent.id} title={state.reason}>
          {agent.alias} · {agent.tenantId} · {state.label}
        </option>;
      })}
    </select>
    {children}
  </div>;
  return host ? createPortal(tools, host) : tools;
}

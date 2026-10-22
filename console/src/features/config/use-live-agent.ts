import { useContext } from 'react';
import { FleetContext } from '../../shell/fleet-context';
import type { LiveAgentView } from '../live/agent-state';
import { fleetAgentId } from '../terminal/fleet';

/** The agent's live view from the shared fleet activity, when activity reports it. */
export function useLiveAgent(tenantId: string, alias: string): LiveAgentView | undefined {
  return useContext(FleetContext)?.live.get(fleetAgentId(tenantId, alias));
}

import {
  FleetHostCreateSchema, FleetHostIdSchema, FleetHostListSchema, FleetHostSchema, FleetHostUpdateSchema,
  type FleetHost, type FleetHostCreate, type FleetHostUpdate,
} from '@cauce/protocol/fleet-hosts';
import type { RequestFn } from './system-client';

export interface FleetHostsClient {
  listFleetHosts(): Promise<FleetHost[]>;
  createFleetHost(input: FleetHostCreate): Promise<FleetHost>;
  updateFleetHost(hostId: string, input: FleetHostUpdate): Promise<FleetHost>;
  deleteFleetHost(hostId: string, expectedVersion: number): Promise<void>;
}

const path = '/v3/console/fleet/hosts';

export function fleetHostsClient(request: RequestFn): FleetHostsClient {
  const hostPath = (hostId: string) => `${path}/${encodeURIComponent(FleetHostIdSchema.parse(hostId))}`;
  return {
    listFleetHosts: async () => FleetHostListSchema.parse(await request(path, { cache: 'no-store' })).hosts,
    createFleetHost: async (input) => FleetHostSchema.parse(await request(path, {
      method: 'POST', body: JSON.stringify(FleetHostCreateSchema.parse(input)),
    })),
    updateFleetHost: async (hostId, input) => FleetHostSchema.parse(await request(hostPath(hostId), {
      method: 'PATCH', body: JSON.stringify(FleetHostUpdateSchema.parse(input)),
    })),
    deleteFleetHost: async (hostId, expectedVersion) => {
      const version = FleetHostUpdateSchema.shape.expected_version.parse(expectedVersion);
      await request(`${hostPath(hostId)}?expected_version=${version}`, { method: 'DELETE' });
    },
  };
}

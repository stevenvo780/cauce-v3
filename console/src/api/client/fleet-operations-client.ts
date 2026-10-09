import {
  FleetOperationControlSchema, FleetOperationPreviewSchema, FleetOperationRequestSchema,
  FleetOperationSchema, FleetTargetSchema,
  type FleetCapability, type FleetOperation, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget,
} from '@cauce/protocol/fleet-operation';
import { FleetCapabilitySchema } from '@cauce/protocol/fleet-operation';
import { ApiError } from './core';
import type { RequestFn } from './system-client';

export interface FleetOperationsClient {
  getFleetCapability(): Promise<FleetCapability>;
  listFleetOperations(target: FleetTarget): Promise<FleetOperation[]>;
  /** Newest first across every target; undefined when the server predates the route. */
  listRecentFleetOperations(limit?: number): Promise<FleetOperation[] | undefined>;
  previewFleetOperation(input: FleetOperationRequest): Promise<FleetOperationPreview>;
  enqueueFleetOperation(input: FleetOperationRequest): Promise<FleetOperation>;
  getFleetOperation(id: string): Promise<FleetOperation>;
  cancelFleetOperation(id: string, expectedVersion: number): Promise<FleetOperation>;
  resumeFleetOperation(id: string, expectedVersion: number): Promise<FleetOperation>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export async function fleetRequestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidReceipt(): never { throw new Error('El recibo del servidor no acredita esta operación de flota. Relee su estado.'); }
function identity(value: FleetTarget): string { return JSON.stringify(canonical(value)); }
function operationId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) invalidReceipt();
  return id;
}
function operationReceipt(value: unknown, id?: string, version?: number): FleetOperation {
  const parsed = FleetOperationSchema.safeParse(value);
  if (!parsed.success || (id !== undefined && parsed.data.id !== id)
    || (version !== undefined && parsed.data.version < version)) invalidReceipt();
  return parsed.data;
}
function exactReceipt(input: FleetOperationRequest, value: unknown, preview: boolean, hash: string) {
  const parsed = preview ? FleetOperationPreviewSchema.safeParse(value) : FleetOperationSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== input.kind || identity(parsed.data.target) !== identity(input.target)
    || parsed.data.expected_revision !== input.expected_revision || parsed.data.request_sha256 !== hash) invalidReceipt();
  return parsed.data;
}

export function fleetOperationsClient(request: RequestFn): FleetOperationsClient {
  const path = '/v3/console/fleet/operations';
  const control = async (action: 'cancel' | 'resume', id: string, version: number) => {
    const input = FleetOperationControlSchema.parse({ expected_version: version });
    return operationReceipt(await request(`${path}/${operationId(id)}/${action}`, { method: 'POST', body: JSON.stringify(input) }), id, version + 1);
  };
  return {
    getFleetCapability: async () => FleetCapabilitySchema.parse(await request('/v3/console/fleet/capability', { cache: 'no-store' })),
    listFleetOperations: async (target) => {
      FleetTargetSchema.parse(target);
      const query = new URLSearchParams(Object.entries(target));
      const value = await request<unknown>(`${path}?${query.toString()}`, { cache: 'no-store' });
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalidReceipt();
      const envelope = value as Record<string, unknown>;
      if (Object.keys(envelope).some((key) => key !== 'operations') || !Array.isArray(envelope.operations) || envelope.operations.length > 100) invalidReceipt();
      return envelope.operations.map((row: unknown) => {
        const operation = operationReceipt(row);
        if (identity(operation.target) !== identity(target)) invalidReceipt();
        return operation;
      });
    },
    listRecentFleetOperations: async (limit = 50) => {
      try {
        const value = await request<unknown>(`/v3/console/fleet/operations/recent?limit=${String(limit)}`, { cache: 'no-store' });
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalidReceipt();
        const envelope = value as Record<string, unknown>;
        if (Object.keys(envelope).some((key) => key !== 'operations') || !Array.isArray(envelope.operations) || envelope.operations.length > 200) invalidReceipt();
        return envelope.operations.map((row: unknown) => operationReceipt(row));
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return undefined;
        throw error;
      }
    },
    previewFleetOperation: async (input) => {
      const validated = FleetOperationRequestSchema.parse(input);
      const hash = await fleetRequestHash(validated);
      return exactReceipt(validated, await request(`${path}/preview`, { method: 'POST', body: JSON.stringify(validated) }), true, hash) as FleetOperationPreview;
    },
    enqueueFleetOperation: async (input) => {
      const validated = FleetOperationRequestSchema.parse(input);
      const hash = await fleetRequestHash(validated);
      const value = await request<unknown>(path, { method: 'POST', body: JSON.stringify(validated) });
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalidReceipt();
      const envelope = value as Record<string, unknown>;
      if (Object.keys(envelope).some((key) => !['operation_id', 'status', 'operation'].includes(key))) invalidReceipt();
      const operation = exactReceipt(validated, envelope.operation, false, hash) as FleetOperation;
      if (envelope.operation_id !== operation.id || envelope.status !== operation.status) invalidReceipt();
      return operation;
    },
    getFleetOperation: async (id) => operationReceipt(await request(`${path}/${operationId(id)}`, { cache: 'no-store' }), id),
    cancelFleetOperation: (id, version) => control('cancel', id, version),
    resumeFleetOperation: (id, version) => control('resume', id, version),
  };
}

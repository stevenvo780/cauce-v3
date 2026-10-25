import { FleetErrorSchema } from '@cauce/protocol';
import { z } from 'zod';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError } from './fleet-operation-contracts.js';

const RollbackIntentSchema = z.object({ original_error: FleetErrorSchema,
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type FleetRollbackIntent = z.infer<typeof RollbackIntentSchema>;

export async function fleetRollbackIntent(client: DatabaseClient, operationId: string): Promise<FleetRollbackIntent | undefined> {
  const event = (await client.query<{ intent: unknown }>(`SELECT metadata->'rollback_requested' AS intent
    FROM fleet_operation_events WHERE operation_id=$1 AND event='failed' AND metadata ? 'rollback_requested'
    ORDER BY id LIMIT 1`, [operationId])).rows[0];
  if (!event) return undefined;
  const parsed = RollbackIntentSchema.safeParse(event.intent);
  if (!parsed.success) throw new FleetOperationError('conflict', 'automatic update restoration has an invalid durable intent');
  return parsed.data;
}

export async function fleetRollbackCompleted(client: DatabaseClient, operationId: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND event='failed'
    AND metadata->>'rollback_completed'='true' LIMIT 1`, [operationId])).rowCount === 1;
}

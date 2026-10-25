import { z } from 'zod';
import { FleetOperationSchema } from './fleet-operation.js';

export const ConsoleFleetOperationSchema = FleetOperationSchema.safeExtend({
  actor: FleetOperationSchema.shape.actor.safeExtend({ display_name: z.string().min(1).max(120).optional() }),
});
export type ConsoleFleetOperation = z.infer<typeof ConsoleFleetOperationSchema>;

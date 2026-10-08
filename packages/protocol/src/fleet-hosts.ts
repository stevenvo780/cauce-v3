import { z } from 'zod';

export const FleetHostIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const FleetHostStatusSchema = z.enum(['unknown', 'reachable', 'unreachable']);
export type FleetHostStatus = z.infer<typeof FleetHostStatusSchema>;

const DisplayNameSchema = z.string().trim().min(1).max(80);
const NotesSchema = z.string().max(500);

export const FleetHostAgentSchema = z.object({
  tenant_id: z.string().min(1),
  alias: z.string().min(1),
  enabled: z.boolean(),
  online: z.boolean(),
}).strict();

/**
 * One computer that runs agents. `status` is the effective reachability: the fleet controller probe when it
 * reported within the freshness window (`status_source: 'controller'`), otherwise derived from the leases of the
 * agents placed on it (`'agents'`), otherwise `'none'`. An agent is usable only when its host is `enabled` and not
 * `unreachable`; a dead host disables only its own agents.
 */
export const FleetHostSchema = z.object({
  host_id: FleetHostIdSchema,
  display_name: z.string().min(1).max(80),
  notes: NotesSchema,
  enabled: z.boolean(),
  status: FleetHostStatusSchema,
  status_source: z.enum(['controller', 'agents', 'none']),
  last_seen_at: z.string().datetime({ offset: true }).nullable(),
  registered: z.boolean(),
  approved: z.boolean(),
  version: z.number().int().nonnegative(),
  agents: z.array(FleetHostAgentSchema).max(1000),
}).strict();
export type FleetHost = z.infer<typeof FleetHostSchema>;

export const FleetHostListSchema = z.object({ hosts: z.array(FleetHostSchema).max(1000) }).strict();
export type FleetHostList = z.infer<typeof FleetHostListSchema>;

export const FleetHostCreateSchema = z.object({
  host_id: FleetHostIdSchema,
  display_name: DisplayNameSchema,
  notes: NotesSchema.default(''),
}).strict();
export type FleetHostCreate = z.infer<typeof FleetHostCreateSchema>;

export const FleetHostUpdateSchema = z.object({
  expected_version: z.number().int().positive(),
  display_name: DisplayNameSchema.optional(),
  notes: NotesSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine(value => value.display_name !== undefined || value.notes !== undefined || value.enabled !== undefined);
export type FleetHostUpdate = z.infer<typeof FleetHostUpdateSchema>;

export function fleetHostUsable(host: Pick<FleetHost, 'enabled' | 'status'>): boolean {
  return host.enabled && host.status !== 'unreachable';
}

import { z } from 'zod';

export const ConfigurationIdentityKeySchema = z.enum([
  'id', 'tenant_id', 'room_id', 'alias', 'agent_alias', 'actor_alias', 'recipient_tenant',
  'recipient_alias', 'from_tenant', 'from_alias', 'to_tenant', 'to_alias', 'account_id',
  'payer_tenant_id', 'account_payer_tenant', 'created_by_tenant', 'role', 'handle', 'human_id',
  'key_id', 'message_id', 'delivery_id', 'kind', 'sha256', 'owner_tenant_id',
  'runtime_key', 'host_id', 'operation_id',
]);
export const ConfigurationIdentitySchema = z.partialRecord(ConfigurationIdentityKeySchema, z.string().max(256));
export const ConfigurationDependencySchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  identity: ConfigurationIdentitySchema, blocking: z.boolean(),
}).strict();

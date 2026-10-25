import { ConsoleFleetOperationSchema, type ConsoleFleetOperation, type FleetOperation } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';

export async function displayFleetOperation(pool: DatabasePool, operation: FleetOperation): Promise<ConsoleFleetOperation> {
  const subject = operation.actor.actor_subject;
  if (!subject?.startsWith('console:')) return operation;
  const person = (await pool.query<{ display_name: string }>(
    `SELECT display_name FROM console_users WHERE 'console:'||id::text=$1 AND tenant_id=$2 AND alias=$3`,
    [subject, operation.actor.tenant_id, operation.actor.alias])).rows[0];
  return ConsoleFleetOperationSchema.parse({ ...operation, actor: { ...operation.actor,
    ...(person === undefined ? {} : { display_name: person.display_name }) } });
}

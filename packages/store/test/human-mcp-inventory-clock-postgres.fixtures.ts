import {
  databasePool,
} from './human-mcp-read-lists-postgres.fixtures.js';

export {
  databasePool, getRepository, inventoryBarrier, reader, readList, waitInventory,
} from './human-mcp-read-lists-postgres.fixtures.js';

export async function seedInventoryLease(alias: string): Promise<void> {
  await databasePool().query(
    `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,capabilities,last_heartbeat_at,lease_until)
     VALUES('Steven',$1,'inventory-clock-test',7,'[]'::jsonb,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute')
     ON CONFLICT(tenant_id,alias) DO UPDATE SET instance_id=EXCLUDED.instance_id,epoch=EXCLUDED.epoch,
       capabilities=EXCLUDED.capabilities,last_heartbeat_at=EXCLUDED.last_heartbeat_at,lease_until=EXCLUDED.lease_until`,
    [alias],
  );
  await databasePool().query(
    `UPDATE agents SET harness_id='codex',enabled=true,container_name='inventory-clock-test',
       runtime_user='dev',home_directory='/tmp/inventory-clock-test',state_directory='/tmp/inventory-clock-test/state'
     WHERE tenant_id='Steven' AND alias=$1`, [alias],
  );
}

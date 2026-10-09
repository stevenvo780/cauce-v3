import { sha256Hex, type FleetOperation, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import { configurationTenantScopeSql } from '../configuration/company-scope.js';
import { withTransaction, type DatabasePool } from '../db.js';
import { assertFleetAuthority, fleetRequest, lockFleetRevision, recordFleetEvent, validateFleetTarget } from './fleet-operation-authority.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationRow } from './fleet-operation-contracts.js';
import { FleetOperationExecution } from './fleet-operation-execution.js';
import { assertFleetHumanAuthority, assertFleetOperationAuthority, loadFleetOrigin } from './fleet-operation-human.js';
import { assertFleetSealedHostBarrier, loadFleetHostSlices } from './fleet-operation-hosts.js';

export class FleetOperationsRepository extends FleetOperationExecution {
  protected readonly controllerHost: string | undefined;
  protected readonly coordinatorEnabled: boolean;
  protected readonly coordinatorHosts: readonly string[] | undefined;
  constructor(pool: DatabasePool, private readonly options: { controllerHost?: string; coordinatorEnabled?: boolean; coordinatorHosts?: readonly string[] } = {}) {
    super(pool); this.controllerHost = options.controllerHost; this.coordinatorEnabled = options.coordinatorEnabled === true;
    this.coordinatorHosts = options.coordinatorHosts === undefined ? undefined : Object.freeze([...options.coordinatorHosts]);
  }
  async preview(tenant: string, alias: string, input: FleetOperationRequest, actorSubject?: string): Promise<FleetOperationPreview> {
    const request = fleetRequest(input);
    return withTransaction(this.pool, async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
      await assertFleetAuthority(client, tenant, alias, request.target);
      await lockFleetRevision(client, request.expected_revision);
      return (await validateFleetTarget(client, request, this.options.controllerHost, false, this.coordinatorEnabled, this.coordinatorHosts)).preview;
    });
  }
  async enqueue(tenant: string, alias: string, input: FleetOperationRequest, actorSubject?: string): Promise<FleetOperation> {
    const request = fleetRequest(input); const hash = sha256Hex(request);
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockFleetRevision(client);
        await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
        await assertFleetAuthority(client, tenant, alias, request.target);
        const prior = (await client.query<FleetOperationRow>(
          'SELECT * FROM fleet_operations WHERE actor_tenant=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR UPDATE',
          [tenant, alias, request.idempotency_key])).rows[0];
        if (prior) {
          await loadFleetOrigin(client, prior);
          if (prior.request_hash !== hash || prior.actor_subject !== actorSubject) {
            throw new FleetOperationError('conflict', 'idempotency key already represents a different request or human origin');
          }
          return publicFleetOperation(prior);
        }
        await lockFleetRevision(client, request.expected_revision);
        const { host, preview } = await validateFleetTarget(client, request, this.options.controllerHost, false, this.coordinatorEnabled, this.coordinatorHosts);
        if (!preview.can_apply) throw new FleetOperationError('conflict', 'target has durable dependencies; retire it instead');
        const inserted = (await client.query<FleetOperationRow>(
          `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,
            request_hash,idempotency_key,expected_revision,steps)
           VALUES($1,$2,$3::jsonb,$4,'fleet',$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) RETURNING *`,
          [tenant, alias, JSON.stringify(request.target), sha256Hex(request.target), host, request.kind, JSON.stringify(request),
            hash, request.idempotency_key, request.expected_revision,
            JSON.stringify(preview.steps.map((name) => ({ name, status: 'pending' })))])).rows[0];
        if (!inserted) throw new Error('fleet operation insert returned no row');
        await recordFleetEvent(client, inserted.id, 0, 'queued', actorSubject === undefined ? {} : { actor_subject: actorSubject });
        return publicFleetOperation(await loadFleetOrigin(client, inserted));
      });
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new FleetOperationError('conflict', 'target already has an unresolved fleet operation');
      }
      throw error;
    }
  }
  async get(tenant: string, alias: string, id: string, actorSubject?: string): Promise<FleetOperation> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [id])).rows[0];
      if (!row) throw new FleetOperationError('not_found', 'fleet operation was not found');
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      await assertFleetAuthority(client, tenant, alias, row.target, false);
      return publicFleetOperation(await loadFleetOrigin(client, row));
    });
  }
  async list(tenant: string, alias: string, target: FleetTarget, actorSubject?: string): Promise<FleetOperation[]> {
    return withTransaction(this.pool, async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      await assertFleetAuthority(client, tenant, alias, target, false);
      const rows = await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE target_key=$1
        ORDER BY created_at DESC,id DESC LIMIT 100`, [sha256Hex(target)]);
      const operations: FleetOperation[] = [];
      for (const row of rows.rows) operations.push(publicFleetOperation(await loadFleetOrigin(client, row)));
      return operations;
    });
  }
  async listRecent(tenant: string, alias: string, limit: number, actorSubject?: string): Promise<FleetOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FleetOperationError('invalid_input', 'recent operation limit is invalid');
    return withTransaction(this.pool, async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      // Read authority is proven against the actor's own tenant; the rows are then scoped to its company (hub) or tenant (non-hub).
      await assertFleetAuthority(client, tenant, alias, { resource: 'tenant', tenant_id: tenant }, false);
      const hub = (await client.query<{ is_hub: boolean }>('SELECT is_hub FROM tenants WHERE id=$1', [tenant])).rows[0]?.is_hub === true;
      const rows = await client.query<FleetOperationRow>(
        `SELECT * FROM fleet_operations operation WHERE ${configurationTenantScopeSql("operation.target->>'tenant_id'", hub)}
         ORDER BY created_at DESC,id DESC LIMIT $2`, [tenant, limit]);
      const operations: FleetOperation[] = [];
      for (const row of rows.rows) operations.push(publicFleetOperation(await loadFleetOrigin(client, row)));
      return operations;
    });
  }
  async cancel(tenant: string, alias: string, id: string, expected: number, actorSubject?: string): Promise<FleetOperation> {
    return this.control(tenant, alias, id, expected, 'cancel', actorSubject);
  }
  async resume(tenant: string, alias: string, id: string, expected: number, actorSubject?: string): Promise<FleetOperation> {
    return this.control(tenant, alias, id, expected, 'resume', actorSubject);
  }
  private async control(tenant: string, alias: string, id: string, expected: number, action: 'cancel' | 'resume', actorSubject?: string): Promise<FleetOperation> {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new FleetOperationError('invalid_input', 'operation version is invalid');
    return withTransaction(this.pool, async (client) => {
      await lockFleetRevision(client);
      const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new FleetOperationError('not_found', 'fleet operation was not found');
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
      await assertFleetAuthority(client, tenant, alias, row.target);
      await assertFleetOperationAuthority(client, row);
      if (Number(row.version) !== expected) throw new FleetOperationError('conflict', 'operation version changed');
      if (row.status === 'cancelled' || row.status === 'succeeded') throw new FleetOperationError('conflict', 'operation is terminal');
      let status: FleetOperation['status'];
      if (action === 'resume') {
        if (!['failed', 'awaiting_auth'].includes(row.status) || row.cancel_requested) throw new FleetOperationError('conflict', 'operation cannot be resumed');
        if (row.kind === 'purge' && row.desired_revision !== null && row.steps.some(step => step.name === 'purge' && step.status === 'succeeded')) {
          await loadFleetHostSlices(client, row);
          for (const step of row.steps.filter(step => step.status === 'succeeded' && !['prepare', 'fence'].includes(step.name))) {
            await assertFleetSealedHostBarrier(client, row, step.name, step.evidence ?? {});
          }
        } else await validateFleetTarget(client, row.request, this.options.controllerHost, row.desired_revision !== null, this.coordinatorEnabled, this.coordinatorHosts);
        await lockFleetRevision(client, Number(row.desired_revision ?? row.expected_revision));
        status = 'queued';
      } else status = row.status === 'queued' && row.steps.every((step) => step.status === 'pending') ? 'cancelled' : 'cancelling';
      const next = (await client.query<FleetOperationRow>(
        `UPDATE fleet_operations SET status=$2,cancel_requested=$3,version=version+1,error=NULL,updated_at=now(),
          worker_id=CASE WHEN $2='queued' THEN NULL ELSE worker_id END,
          claim_token=CASE WHEN $2='queued' THEN NULL ELSE claim_token END,
          lease_expires_at=CASE WHEN $2='queued' THEN NULL ELSE lease_expires_at END
         WHERE id=$1 RETURNING *`, [id, status, action === 'cancel'])).rows[0];
      if (!next) throw new Error('fleet operation control returned no row');
      await recordFleetEvent(client, id, Number(next.version), action === 'resume' ? 'resumed' : status === 'cancelled' ? 'cancelled' : 'cancel_requested',
        { actor_tenant: tenant, actor_alias: alias, ...(actorSubject === undefined ? {} : { actor_subject: actorSubject }) });
      return publicFleetOperation(await loadFleetOrigin(client, next));
    });
  }
}

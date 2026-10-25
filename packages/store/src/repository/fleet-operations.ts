import { FleetOperationSubmissionSchema, sha256Hex, type FleetOperation, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from '../db.js';
import { assertFleetAuthority, assertFleetTargetAuthority, fleetRequest, lockFleetRevision, recordFleetEvent, resolveFleetAuthority,
  validateFleetTarget, type FleetAuthorityScope } from './fleet-operation-authority.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationRow } from './fleet-operation-contracts.js';
import { FleetOperationExecution } from './fleet-operation-execution.js';
import { assertFleetHumanAuthority, assertFleetOperationAuthority, loadFleetOrigin } from './fleet-operation-human.js';
import { assertFleetSealedHostBarrier, loadFleetHostSlices } from './fleet-operation-hosts.js';
import { lockPreparedFleetRevision } from './fleet-operation-slice.js';
import type { CompanyAuthoritySource } from './fleet-hosts.js';
import { fleetRollbackCompleted, fleetRollbackIntent } from './fleet-operation-rollback-intent.js';
import { fleetReplacementCommit } from './fleet-operation-retirement.js';

export class FleetOperationsRepository extends FleetOperationExecution {
  protected readonly controllerHost: string | undefined;
  protected readonly coordinatorEnabled: boolean;
  protected readonly coordinatorHosts: readonly string[] | undefined;
  constructor(pool: DatabasePool, private readonly options: { controllerHost?: string; coordinatorEnabled?: boolean; coordinatorHosts?: readonly string[];
    transactionClient?: DatabaseClient; authorityScope?: FleetAuthorityScope; stepMaxMs?: number } = {}) {
    super(pool, options.transactionClient, options.stepMaxMs); this.controllerHost = options.controllerHost; this.coordinatorEnabled = options.coordinatorEnabled === true;
    this.coordinatorHosts = options.coordinatorHosts === undefined ? undefined : Object.freeze([...options.coordinatorHosts]);
  }
  forTransaction(client: DatabaseClient): FleetOperationsRepository {
    return new FleetOperationsRepository(this.pool, { ...this.options, transactionClient: client });
  }
  forCompany(company: string): FleetOperationsRepository {
    return new FleetOperationsRepository(this.pool, { ...this.options, authorityScope: company });
  }
  forAuthority(authority: CompanyAuthoritySource): FleetOperationsRepository {
    return new FleetOperationsRepository(this.pool, { ...this.options, authorityScope: authority });
  }
  async preview(tenant: string, alias: string, input: FleetOperationRequest, actorSubject?: string): Promise<FleetOperationPreview> {
    const request = fleetRequest(input);
    return this.transaction(async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
      const authority = await assertFleetAuthority(client, tenant, alias, request.target, true, actorSubject, this.options.authorityScope);
      await lockFleetRevision(client, request.expected_revision, authority.actingCompany);
      return (await validateFleetTarget(client, request, this.options.controllerHost, false, this.coordinatorEnabled, this.coordinatorHosts)).preview;
    });
  }
  async enqueue(tenant: string, alias: string, input: FleetOperationRequest, actorSubject?: string): Promise<FleetOperation> {
    const parsed = FleetOperationSubmissionSchema.safeParse(input);
    if (!parsed.success) throw new FleetOperationError('invalid_input', 'fleet operation submission is invalid');
    const request = parsed.data; const hash = sha256Hex(request);
    try {
      return await this.transaction(async (client) => {
        await lockFleetRevision(client);
        await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
        const authority = await assertFleetAuthority(client, tenant, alias, request.target, true, actorSubject, this.options.authorityScope);
        const prior = (await client.query<FleetOperationRow>(
          'SELECT * FROM fleet_operations WHERE actor_tenant=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR UPDATE',
          [tenant, alias, request.idempotency_key])).rows[0];
        if (prior) {
          await loadFleetOrigin(client, prior);
          if (prior.request_hash !== hash || prior.actor_subject !== actorSubject || prior.company_id !== authority.actingCompany
              || (prior.acting_company !== undefined && prior.acting_company !== authority.actingCompany)) {
            throw new FleetOperationError('conflict', 'idempotency key already represents a different request, company or human origin');
          }
          return publicFleetOperation(prior);
        }
        await lockFleetRevision(client, request.expected_revision, authority.actingCompany);
        const { host, preview } = await validateFleetTarget(client, request, this.options.controllerHost, false, this.coordinatorEnabled, this.coordinatorHosts);
        if (!preview.can_apply) throw new FleetOperationError('conflict', 'target has durable dependencies; retire it instead');
        const inserted = (await client.query<FleetOperationRow>(
          `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,
            request_hash,idempotency_key,expected_revision,steps,company_id)
           VALUES($1,$2,$3::jsonb,$4,$13,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
          [tenant, alias, JSON.stringify(request.target), sha256Hex(request.target), host, request.kind, JSON.stringify(request),
            hash, request.idempotency_key, request.expected_revision,
            JSON.stringify(preview.steps.map((name) => ({ name, status: 'pending' }))), authority.actingCompany,
            `fleet:${authority.actingCompany}:${host}`])).rows[0];
        if (!inserted) throw new Error('fleet operation insert returned no row');
        await recordFleetEvent(client, inserted.id, 0, 'queued', { acting_company: authority.actingCompany,
          ...(actorSubject === undefined ? {} : { actor_subject: actorSubject }) });
        return publicFleetOperation(await loadFleetOrigin(client, inserted));
      });
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new FleetOperationError('conflict', 'target already has an unresolved fleet operation');
      }
      throw error;
    }
  }
  /** An operation of another company reads as absent, even when its target tenant has since moved here. */
  async get(tenant: string, alias: string, id: string, actorSubject?: string): Promise<FleetOperation> {
    return this.transaction(async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      const authority = await resolveFleetAuthority(client, tenant, alias, actorSubject, this.options.authorityScope);
      const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1 AND company_id=$2',
        [id, authority.actingCompany])).rows[0];
      if (!row) throw new FleetOperationError('not_found', 'fleet operation was not found');
      await assertFleetTargetAuthority(client, authority, tenant, row.target, false);
      return publicFleetOperation(await loadFleetOrigin(client, row));
    });
  }
  async list(tenant: string, alias: string, target: FleetTarget, actorSubject?: string): Promise<FleetOperation[]> {
    return this.transaction(async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      const authority = await assertFleetAuthority(client, tenant, alias, target, false, actorSubject, this.options.authorityScope);
      const rows = await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE target_key=$1 AND company_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 100`, [sha256Hex(target), authority.actingCompany]);
      const operations: FleetOperation[] = [];
      for (const row of rows.rows) operations.push(publicFleetOperation(await loadFleetOrigin(client, row)));
      return operations;
    });
  }
  async listRecent(tenant: string, alias: string, limit: number, actorSubject?: string): Promise<FleetOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FleetOperationError('invalid_input', 'recent operation limit is invalid');
    return this.transaction(async (client) => {
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject, false);
      const authority = await resolveFleetAuthority(client, tenant, alias, actorSubject, this.options.authorityScope);
      if (!['company', 'platform', 'tenant'].includes(authority.scope)) throw new FleetOperationError('forbidden', 'fleet read authority is unavailable');
      const company = authority.scope === 'company' || authority.scope === 'platform';
      const rows = await client.query<FleetOperationRow>(
        `SELECT * FROM fleet_operations operation WHERE operation.company_id=$1 AND ($2::text IS NULL OR operation.target->>'tenant_id'=$2)
         ORDER BY created_at DESC,id DESC LIMIT $3`, [authority.actingCompany, company ? null : tenant, limit]);
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
    return this.transaction(async (client) => {
      await lockFleetRevision(client);
      const row = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new FleetOperationError('not_found', 'fleet operation was not found');
      await assertFleetHumanAuthority(client, tenant, alias, actorSubject);
      const authority = await resolveFleetAuthority(client, tenant, alias, actorSubject, this.options.authorityScope);
      if (row.company_id !== authority.actingCompany) throw new FleetOperationError('not_found', 'fleet operation was not found');
      await assertFleetTargetAuthority(client, authority, tenant, row.target, true);
      await assertFleetOperationAuthority(client, row);
      if (Number(row.version) !== expected) throw new FleetOperationError('conflict', 'operation version changed');
      if (row.status === 'cancelled' || row.status === 'succeeded') throw new FleetOperationError('conflict', 'operation is terminal');
      if (await fleetReplacementCommit(client, row.id) !== undefined) throw new FleetOperationError('conflict', 'replacement is committed and its retirement must finish');
      const restoredFailure = row.status === 'failed' && await fleetRollbackCompleted(client, row.id);
      let status: FleetOperation['status'];
      if (action === 'resume') {
        if (restoredFailure || await fleetRollbackIntent(client, row.id) !== undefined) {
          throw new FleetOperationError('conflict', 'the failed update requires restoration or a new update after closing it');
        }
        if (!['failed', 'awaiting_auth'].includes(row.status) || row.cancel_requested) throw new FleetOperationError('conflict', 'operation cannot be resumed');
        if (row.kind === 'purge' && row.desired_revision !== null && row.steps.some(step => step.name === 'purge' && step.status === 'succeeded')) {
          await loadFleetHostSlices(client, row);
          for (const step of row.steps.filter(step => step.status === 'succeeded' && !['prepare', 'fence'].includes(step.name))) {
            await assertFleetSealedHostBarrier(client, row, step.name, step.evidence ?? {});
          }
        } else await validateFleetTarget(client, row.request, this.options.controllerHost, row.desired_revision !== null, this.coordinatorEnabled, this.coordinatorHosts);
        if (row.desired_revision === null) await lockFleetRevision(client, Number(row.expected_revision), row.company_id);
        else await lockPreparedFleetRevision(client, row);
        status = 'queued';
      } else status = restoredFailure || (row.status === 'queued' || row.kind === 'recover' && row.desired_revision === null)
        && row.steps.every((step) => step.status === 'pending') ? 'cancelled' : 'cancelling';
      const next = (await client.query<FleetOperationRow>(
        `UPDATE fleet_operations SET status=$2,cancel_requested=$3,version=version+1,error=NULL,updated_at=now(),
          worker_id=CASE WHEN $2 IN ('queued','cancelled') THEN NULL ELSE worker_id END,
          claim_token=CASE WHEN $2 IN ('queued','cancelled') THEN NULL ELSE claim_token END,
          lease_expires_at=CASE WHEN $2 IN ('queued','cancelled') THEN NULL ELSE lease_expires_at END
         WHERE id=$1 RETURNING *`, [id, status, action === 'cancel'])).rows[0];
      if (!next) throw new Error('fleet operation control returned no row');
      await recordFleetEvent(client, id, Number(next.version), action === 'resume' ? 'resumed' : status === 'cancelled' ? 'cancelled' : 'cancel_requested',
        { actor_tenant: tenant, actor_alias: alias, ...(restoredFailure ? { rollback_archived: true } : {}),
          ...(actorSubject === undefined ? {} : { actor_subject: actorSubject }) });
      return publicFleetOperation(await loadFleetOrigin(client, next));
    });
  }
}

import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { QuotaProviderReportSchema, type Tenant } from '@cauce/protocol';
import { CauceRepository } from './repository.js';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { lockCompanyAuthority } from './company-authority.js';
import { assertQuotaAuthority } from './quota-accounts.js';
import { StoreError } from './repository/errors.js';
import { assertQuotaEnvironmentIdentity, bindQuotaEnvironmentIdentity } from './quota-identity.js';
import { expireQuotaAuthentication } from './quota-auth-expiry.js';

export type QuotaFailureDetail = 'runtime_release_stale' | 'runtime_image_stale' | 'reader_unreadable' | 'environment_not_running' | 'isolation_rejected' | 'cli_update_failed' | 'cli_update_timed_out';

const Result = z.object({ runtime_verified: z.literal(true).optional(), container_name: z.string().regex(/^cauce-quota-[a-f0-9]{32}$/u).optional(),
  authenticated_verified: z.literal(true).optional(), account_identity: z.string().min(1).max(256).optional(), account_id: z.string().optional(),
  cli_updated_verified: z.literal(true).optional(), cli_version: z.string().min(1).max(256).optional(),
  stopped_verified: z.literal(true).optional(), profile_removed_verified: z.literal(true).optional(),
  provider_report: QuotaProviderReportSchema.optional(), captured_at: z.iso.datetime({ offset: true }).optional(),
  observation_status: z.enum(['unknown','error','stale','ok']).optional(),
  output: z.string().max(4096).optional(), login_url: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !/[?&](?:access_token|refresh_token|id_token|authorization)=/iu.test(url.search);
  }).optional(), user_code: z.string().regex(/^[A-Za-z0-9 -]{1,128}$/u).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
}).strict();
export interface QuotaOperationClaim {
  id: string; environment_id: string; claim_token: string; claim_epoch: number; worker_id: string;
}
export interface QuotaOperationExecution {
  operation_id: string; action: 'create' | 'authenticate' | 'query' | 'update_cli' | 'delete'; consent: boolean;
  environment: { id: string; company_id: string; account_id: string; host_id: string; provider: string; container_name: string };
}
interface ClaimRow extends QuotaOperationClaim { requested_by: string; company_id: string; tenant_id: string; alias: string }
export class QuotaOperationsRepository {
  constructor(private readonly pool: DatabasePool, private readonly transactionClient?: DatabaseClient) {}
  forTransaction(client: DatabaseClient): QuotaOperationsRepository { return new QuotaOperationsRepository(this.pool, client); }
  private transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return this.transactionClient === undefined ? withTransaction(this.pool, work) : work(this.transactionClient);
  }
  async assertHostScopeInTransaction(client: DatabaseClient, claim: QuotaOperationClaim,
    scope: { host_id: string; company_id: string; allowTerminal?: boolean }): Promise<void> {
    const result = await client.query(`SELECT op.id FROM quota_environment_operations op
      JOIN quota_environments environment ON environment.id=op.environment_id AND environment.company_id=op.company_id
      WHERE op.id=$1 AND op.environment_id=$2 AND op.claim_token=$3 AND op.claim_epoch=$4 AND op.worker_id=$5
        AND environment.host_id=$6 AND environment.company_id=$7 AND op.status=ANY($8::text[]) FOR SHARE OF op,environment`,
    [claim.id, claim.environment_id, claim.claim_token, claim.claim_epoch, claim.worker_id, scope.host_id, scope.company_id,
      scope.allowTerminal === true ? ['running','awaiting_auth','done','failed'] : ['running','awaiting_auth']]);
    if (!result.rowCount) throw new StoreError('forbidden', 'quota operation is outside the authenticated host scope');
  }
  private async authorize(client: DatabaseClient, id: string): Promise<void> {
    const row = (await client.query<ClaimRow>(`SELECT op.requested_by,op.company_id,person.tenant_id,person.alias
      FROM quota_environment_operations op JOIN console_users person ON person.id=op.requested_by WHERE op.id=$1`, [id])).rows[0];
    if (!row) throw new StoreError('forbidden', 'quota operation authority is unavailable');
    const authority = await lockCompanyAuthority(client, { tenant: row.tenant_id, alias: row.alias,
      humanId: row.requested_by, requestedCompany: row.company_id });
    assertQuotaAuthority(authority, true);
    if (authority.actingCompany !== row.company_id) throw new StoreError('forbidden', 'quota operation company authority was revoked');
  }
  private async retainAuthority(client: DatabaseClient, claim: QuotaOperationClaim): Promise<boolean> {
    try { await this.authorize(client, claim.id); return true; } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      await client.query(`UPDATE quota_environment_operations SET status='failed',error_code='AUTHORITY_REVOKED',lease_until=NULL,updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4`, [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id]);
      await client.query(`UPDATE quota_environments SET status='failed',version=version+1,updated_at=now()
        WHERE id=(SELECT environment_id FROM quota_environment_operations WHERE id=$1)`, [claim.id]);
      return false;
    }
  }
  async claim(worker: string, host: string, leaseMs = 30_000): Promise<QuotaOperationClaim | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(host)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new StoreError('invalid_input', 'invalid quota worker lease');
    return this.transaction(async client => {
      await expireQuotaAuthentication(client, { hostId: host });
      const row = (await client.query<ClaimRow>(`SELECT op.id,op.environment_id,op.requested_by,op.company_id,person.tenant_id,person.alias
        FROM quota_environment_operations op JOIN quota_environments environment ON environment.id=op.environment_id
        JOIN console_users person ON person.id=op.requested_by WHERE environment.host_id=$1
          AND (op.status='pending' OR (op.status='running' AND op.lease_until<now()))
        ORDER BY op.created_at,op.id FOR UPDATE OF op SKIP LOCKED LIMIT 1`, [host])).rows[0];
      if (!row) return null;
      try {
        const authority = await lockCompanyAuthority(client, { tenant: row.tenant_id, alias: row.alias,
          humanId: row.requested_by, requestedCompany: row.company_id });
        assertQuotaAuthority(authority, true);
        if (authority.actingCompany !== row.company_id) throw new StoreError('forbidden', 'quota operation company authority was revoked');
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        await client.query("UPDATE quota_environment_operations SET status='failed',error_code='AUTHORITY_REVOKED',updated_at=now() WHERE id=$1", [row.id]);
        return null;
      }
      const claimed = (await client.query<QuotaOperationClaim>(`UPDATE quota_environment_operations SET status='running',worker_id=$2,
        claim_token=gen_random_uuid(),claim_epoch=claim_epoch+1,lease_until=now()+($3::double precision*interval '1 millisecond'),updated_at=now()
        WHERE id=$1 RETURNING id,environment_id,claim_token,claim_epoch::int,worker_id`, [row.id, worker, leaseMs])).rows[0];
      return claimed ?? null;
    });
  }
  async renew(claim: QuotaOperationClaim, leaseMs = 30_000): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new StoreError('invalid_input', 'invalid quota worker lease');
    return this.transaction(async client => {
      await expireQuotaAuthentication(client, { operationId: claim.id });
      const result = await client.query(`UPDATE quota_environment_operations SET lease_until=now()+($5::double precision*interval '1 millisecond')
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4 AND status='running' AND lease_until>now()`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, leaseMs]);
      return result.rowCount === 1 && await this.retainAuthority(client, claim);
    });
  }
  async execution(claim: QuotaOperationClaim): Promise<QuotaOperationExecution> {
    return this.transaction(async client => {
      const row = (await client.query<QuotaOperationExecution>(`SELECT op.id AS operation_id,op.action,op.consent,
      jsonb_build_object('id',environment.id,'company_id',environment.company_id,'account_id',environment.account_id,
        'host_id',environment.host_id,'provider',environment.provider,'container_name',environment.container_name) AS environment
      FROM quota_environment_operations op JOIN quota_environments environment ON environment.id=op.environment_id
      WHERE op.id=$1 AND op.claim_token=$2 AND op.claim_epoch=$3 AND op.worker_id=$4 AND op.status='running' AND op.lease_until>now() FOR UPDATE OF op`,
    [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id])).rows[0];
      if (!row) throw new StoreError('conflict', 'quota execution lease was replaced');
      await this.authorize(client, claim.id);
      return row;
    });
  }
  async resumeAuthentication(claim: QuotaOperationClaim): Promise<boolean> {
    return this.transaction(async client => {
      await expireQuotaAuthentication(client, { operationId: claim.id });
      const result = await client.query(`UPDATE quota_environment_operations SET status='running',lease_until=now()+interval '30 seconds',updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4 AND status='awaiting_auth' AND action='authenticate'`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id]);
      return result.rowCount === 1 && await this.retainAuthority(client, claim);
    });
  }
  async finish(claim: QuotaOperationClaim, value: unknown, awaitingAuth = false) {
    const result = Result.parse(value);
    const expiry = result.expires_at === undefined ? NaN : Date.parse(result.expires_at);
    if (awaitingAuth && (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now()+900_000)) {
      throw new StoreError('invalid_input', 'quota authentication expiry must be in the next 900 seconds');
    }
    if (result.output && /(?:access_token|refresh_token|id_token|authorization|Bearer\s)/iu.test(result.output)) delete result.output;
    return this.transaction(async client => {
      const previous = (await client.query<{ environment_id: string; status: string; action: string; result: Record<string, unknown> }>(
        `SELECT environment_id,status,action,result FROM quota_environment_operations WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3
          AND worker_id=$4 AND status=ANY($5::text[]) AND environment_id=$6 FOR UPDATE`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, ['done','awaiting_auth'], claim.environment_id])).rows[0];
      if (previous) {
        await this.authorize(client, claim.id);
        if (previous.action === 'authenticate' && previous.status === 'done') {
          const accountId = previous.result.account_id;
          if (result.authenticated_verified !== true || result.account_identity === undefined || typeof accountId !== 'string'
              || result.account_id !== undefined && result.account_id !== accountId) {
            throw new StoreError('conflict', 'quota terminal authentication receipt is incomplete');
          }
          await assertQuotaEnvironmentIdentity(client, previous.environment_id, accountId, result.account_identity);
          delete result.account_identity; result.account_id = accountId;
        }
        if (previous.status !== (awaitingAuth ? 'awaiting_auth' : 'done') || !isDeepStrictEqual(previous.result, result)) {
          throw new StoreError('conflict', 'quota terminal receipt differs from the accepted result');
        }
        return { operation_id: claim.id, status: previous.status };
      }
      const operation = (await client.query<{ environment_id: string; action: string }>(`SELECT environment_id,action FROM quota_environment_operations
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4 AND status='running' AND lease_until>now()
          AND environment_id=$5 AND (action<>'authenticate' OR result->>'expires_at' IS NULL OR (result->>'expires_at')::timestamptz>now()) FOR UPDATE`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, claim.environment_id])).rows[0];
      if (!operation) throw new StoreError('conflict', 'quota execution lease was replaced');
      await this.authorize(client, claim.id);
      if (operation.action === 'create' && result.runtime_verified !== true
        || operation.action === 'delete' && (result.stopped_verified !== true || result.profile_removed_verified !== true)
        || operation.action === 'update_cli' && result.cli_updated_verified !== true
        || operation.action === 'query' && (result.provider_report === undefined || result.captured_at === undefined)
        || operation.action === 'authenticate' && !awaitingAuth && (result.authenticated_verified !== true || result.account_identity === undefined)
        || awaitingAuth && operation.action !== 'authenticate'
        || result.account_identity !== undefined && (operation.action !== 'authenticate' || awaitingAuth)) {
        throw new StoreError('invalid_input', 'quota effect receipt is incomplete');
      }
      if (operation.action === 'authenticate' && !awaitingAuth && result.account_identity !== undefined) {
        result.account_id = await bindQuotaEnvironmentIdentity(client, operation.environment_id, result.account_identity);
        delete result.account_identity;
      }
      if (operation.action === 'query' && result.provider_report !== undefined && result.captured_at !== undefined) {
        const environment = (await client.query<{ payer_tenant_id: Tenant; account_id: string; container_name: string; provider: string }>(
          `SELECT p.payer_tenant_id,e.account_id,e.container_name,e.provider FROM quota_environments e
           JOIN provider_accounts p ON p.id=e.account_id AND p.company_id=e.company_id WHERE e.id=$1 FOR SHARE OF e,p`,
          [operation.environment_id])).rows[0];
        if (!environment || result.provider_report.account_id !== environment.account_id
            || result.provider_report.provider !== environment.provider
            || result.provider_report.windows.some(window => window.account_id !== environment.account_id)) {
          throw new StoreError('invalid_input', 'quota receipt account identity differs');
        }
        await new CauceRepository(this.pool).recordQuotaSample(environment.payer_tenant_id, 'quota_environment', {
          host: environment.container_name, captured_at: result.captured_at, schema_version: 2, providers: [result.provider_report],
        }, client);
      }
      await client.query(`UPDATE quota_environment_operations SET status=$5,result=$6::jsonb,lease_until=NULL,updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, awaitingAuth ? 'awaiting_auth' : 'done', JSON.stringify(result)]);
      await client.query(`UPDATE quota_environments SET status=$2,version=version+1,updated_at=now() WHERE id=$1`,
      [operation.environment_id, operation.action === 'delete' ? 'deleted' : awaitingAuth ? 'awaiting_auth' : 'ready']);
      return { operation_id: claim.id, status: awaitingAuth ? 'awaiting_auth' : 'done' };
    });
  }
  async fail(claim: QuotaOperationClaim, code: 'PROVIDER_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'STEP_FAILED' | 'AUTH_CANCELLED', detail?: QuotaFailureDetail) {
    return this.transaction(async client => {
      const result = await client.query<{ environment_id: string; action: string; result: Record<string, unknown> | null }>(`UPDATE quota_environment_operations SET status='failed',error_code=$5,lease_until=NULL,updated_at=now(),
        result=CASE WHEN $7::text IS NULL THEN result ELSE COALESCE(result, '{}'::jsonb) || jsonb_build_object('failure_reason', $7::text) END
        WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4 AND environment_id=$6
          AND status='running' AND lease_until>now() RETURNING environment_id,action,result`,
      [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, code, claim.environment_id, detail ?? null]);
      if (!result.rowCount) {
        const previous = await client.query(`SELECT 1 FROM quota_environment_operations WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3
          AND worker_id=$4 AND status='failed' AND error_code=$5 AND environment_id=$6`,
        [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, code, claim.environment_id]);
        if (previous.rowCount) return;
        throw new StoreError('conflict', 'quota execution lease was replaced');
      }
      const operation = result.rows[0];
      const loginStopped = operation?.action === 'authenticate' && code === 'AUTH_CANCELLED'
        && typeof operation.result?.expires_at === 'string';
      await client.query('UPDATE quota_environments SET status=$2,version=version+1,updated_at=now() WHERE id=$1',
        [operation?.environment_id, loginStopped ? 'ready' : 'failed']);
    });
  }
}

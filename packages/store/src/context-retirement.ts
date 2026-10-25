import {
  ContextRetirementPreviewSchema, sha256Hex, type ContextRetirementApply, type ContextRetirementPreview,
  type ContextRetirementPreviewRequest, type ContextRetirementReceipt,
} from '@cauce/protocol';
import { assertPlatformAdmin } from './company-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { ContextGitRetirementBroker, requireTestContextCompany } from './context-git-retirement.js';
import { withBrokerLock } from './context-version-worker.js';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

const COMPANY_LOCK = 783_003_004;

/** Uses the same per-company key as registration; remote Git runs after both session locks release. */
async function withCompanyLock<T>(client: DatabaseClient, company: string, work: () => Promise<T>): Promise<T> {
  const locked = (await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::integer,hashtext($2)) AS locked', [COMPANY_LOCK, company])).rows[0]?.locked === true;
  if (!locked) throw new StoreError('conflict', 'context company is busy');
  const unlock = async () => {
    if ((await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::integer,hashtext($2)) AS unlocked', [COMPANY_LOCK, company])
      .catch(() => undefined))?.rows[0]?.unlocked !== true) throw new StoreError('conflict', 'context company unlock is uncertain');
  };
  let result: T;
  try { result = await work(); } catch (error) {
    await unlock();
    throw error;
  }
  await unlock();
  return result;
}

export class ContextRetirementService {
  private readonly git: ContextGitRetirementBroker;
  constructor(private readonly pool: DatabasePool, repositoryRoot: string) {
    this.git = new ContextGitRetirementBroker(repositoryRoot);
  }

  private async references(source: CompanyAuthoritySource, company: string) {
    requireTestContextCompany(company);
    return withTransaction(this.pool, async client => {
      const actor = await source(client);
      assertPlatformAdmin(actor);
      if (actor.actingCompany !== 'humanizar') throw new StoreError('forbidden', 'context retirement requires the Humanizar platform scope');
      const row = (await client.query<Record<string, string>>(`SELECT
        (SELECT count(*)::text FROM companies WHERE id=$1) AS companies,
        (SELECT count(*)::text FROM tenants WHERE company_id=$1) AS tenants,
        (SELECT count(*)::text FROM agents WHERE company_id=$1) AS agents,
        (SELECT count(*)::text FROM agent_context_state WHERE company_id=$1) AS context_states,
        (SELECT count(*)::text FROM agent_context_outbox WHERE company_id=$1 AND state<>'synced') AS context_pending,
        (SELECT count(*)::text FROM agent_context_outbox WHERE company_id=$1) AS context_outbox,
        (SELECT count(*)::text FROM agent_context_versions WHERE company_id=$1) AS context_history,
        (SELECT count(*)::text FROM fleet_operations WHERE company_id=$1 AND status IN
          ('queued','running','awaiting_auth','cancelling')) AS fleet_open`, [company])).rows[0];
      if (!row) throw new StoreError('conflict', 'context references are unavailable');
      const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
      if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new StoreError('conflict', 'context reference counts are invalid');
      }
      const blockers = ['companies', 'tenants', 'agents', 'context_states', 'context_pending', 'fleet_open']
        .filter(key => counts[key] !== 0);
      return { pin: sha256Hex({ company_id: company, counts }), blockers };
    });
  }

  private async localPreview(source: CompanyAuthoritySource, input: ContextRetirementPreviewRequest,
    remote: string): Promise<ContextRetirementPreview> {
    const references = await this.references(source, input.company_id);
    const snapshot = await this.git.snapshot(input.company_id, input.action, input.retirement_commit);
    const blockers = [...references.blockers];
    if (remote !== snapshot.head) blockers.push('remote_head_differs');
    const value = { version: 1 as const, company_id: input.company_id, action: input.action,
      head: snapshot.head, remote_head: remote, tree_oid: snapshot.tree_oid, entry_count: snapshot.entry_count,
      logical_bytes: snapshot.logical_bytes, db_pin_sha256: references.pin, can_apply: blockers.length === 0,
      blockers, ...(input.retirement_commit ? { retirement_commit: input.retirement_commit } : {}) };
    return ContextRetirementPreviewSchema.parse({ ...value, preview_sha256: sha256Hex(value) });
  }

  async preview(source: CompanyAuthoritySource, input: ContextRetirementPreviewRequest): Promise<ContextRetirementPreview> {
    await this.references(source, input.company_id);
    const remote = await this.git.remoteHead();
    const result = await withBrokerLock(this.pool, client => withCompanyLock(client, input.company_id,
      () => this.localPreview(source, input, remote)));
    if (result === 'busy') throw new StoreError('conflict', 'context broker is busy');
    return result;
  }

  async apply(source: CompanyAuthoritySource, input: ContextRetirementApply,
    action: 'retire' | 'restore'): Promise<ContextRetirementReceipt> {
    await this.references(source, input.company_id);
    const remote = await this.git.remoteHead();
    const result = await withBrokerLock(this.pool, client => withCompanyLock(client, input.company_id, async () => {
      const references = await this.references(source, input.company_id);
      if (references.blockers.length) throw new StoreError('conflict', 'context company is still referenced');
      const existing = await this.git.lookup(input.operation_id);
      if (existing) {
        if (existing.company_id !== input.company_id || existing.action !== action || existing.before_head !== input.expected_head
            || existing.preview_sha256 !== input.preview_sha256 || existing.retirement_commit !== input.retirement_commit) {
          throw new StoreError('conflict', 'context operation identity was reused for another action');
        }
        return existing;
      }
      const preview = await this.localPreview(source, { company_id: input.company_id, action,
        ...(input.retirement_commit ? { retirement_commit: input.retirement_commit } : {}) }, remote);
      if (!preview.can_apply || preview.head !== input.expected_head || preview.preview_sha256 !== input.preview_sha256) {
        throw new StoreError('conflict', 'context retirement preview changed');
      }
      return this.git.change(preview, input.operation_id);
    }));
    if (result === 'busy') throw new StoreError('conflict', 'context broker is busy');
    return this.git.publish(result, remote);
  }

  async status(source: CompanyAuthoritySource, company: string, operation: string): Promise<ContextRetirementReceipt> {
    const references = await this.references(source, company);
    if (references.blockers.length) throw new StoreError('conflict', 'context company is still referenced');
    const receipt = await withBrokerLock(this.pool, client => withCompanyLock(client, company,
      () => this.git.lookup(operation)));
    if (receipt === 'busy') throw new StoreError('conflict', 'context broker is busy');
    if (receipt?.company_id !== company) throw new StoreError('not_found', 'context operation is unavailable');
    return this.git.observe(receipt);
  }
}

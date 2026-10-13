import type { QuotaSampleRequest, Tenant } from '@cauce/protocol';
import { SUPPORTED_QUOTA_SCHEMA_VERSIONS } from '@cauce/protocol';
import { AUTOMATIC_PAUSE_PREFIX } from '../accounts.js';
import { quotaObservationStatus, quotaRemaining, QUOTA_STALE_AFTER_SECONDS, type QuotaObservationStatus } from '../quota-state.js';
import { withTransaction, type DatabaseClient } from '../db.js';
import { tenantReadableSql } from './acl-edges.js';
import { DeliveryControlRepository } from './deliveries/control.js';
import { StoreError } from './errors.js';

// ============================================================================================
// AI subscription quotas (GET /v3/console/quotas, POST /v3/quotas/samples). See
// packages/store/migrations/013_quota_observation.sql for the why behind the four tables.
// ============================================================================================

export interface QuotaThresholds {
  stale_after_seconds: number;
  warn_remaining_percent: number;
  critical_remaining_percent: number;
  history_window_seconds: number;
  history_bucket_seconds: number;
  history_max_points: number;
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  stale_after_seconds: QUOTA_STALE_AFTER_SECONDS,
  warn_remaining_percent: 25,
  critical_remaining_percent: 10,
  history_window_seconds: 86_400,
  history_bucket_seconds: 1_800,
  history_max_points: 48
};

export interface QuotaSampleUnboundGroup {
  host: string;
  provider: string;
  group_key: string;
  window_count: number;
  reason: 'no_account_id_supplied' | 'unknown_account_id';
  detail: string;
}

export interface QuotaSamplePausedAccount {
  account_id: string;
  provider: string;
  group_key: string;
  window_key: string;
  paused_until: string;
}

export interface QuotaSampleResumedAccount {
  account_id: string;
  provider: string;
}

export interface QuotaSampleIngestResult {
  collection_id: string;
  host: string;
  captured_at: string;
  duplicate: boolean;
  accepted_providers: number;
  accepted_windows: number;
  unbound_groups: QuotaSampleUnboundGroup[];
  paused_accounts: QuotaSamplePausedAccount[];
  resumed_accounts: QuotaSampleResumedAccount[];
  pruned_collections: number;
}

export type QuotaSeverity = 'unknown' | 'ok' | 'warn' | 'critical' | 'exhausted';

/** Pure and testable without Postgres, same reason as agentWorkState(): it decides whether
 *  the operator sees "all good" or "about to run out", so it is the part that needs a real
 *  test. */
export function windowSeverity(
  remainingPercent: number | null,
  status: string | null,
  thresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS
): QuotaSeverity {
  if ((remainingPercent !== null && remainingPercent <= 0) || status === 'rate-limited') return 'exhausted';
  if (remainingPercent === null) return 'unknown';
  if (remainingPercent < thresholds.critical_remaining_percent) return 'critical';
  if (remainingPercent < thresholds.warn_remaining_percent) return 'warn';
  return 'ok';
}

const QUOTA_SEVERITY_RANK: Readonly<Record<QuotaSeverity, number>> = {
  unknown: 0, ok: 1, warn: 2, critical: 3, exhausted: 4
};

/** Severity of a group/provider = the worst among its parts: a single exhausted group cannot
 *  stay hidden behind other healthy groups of the same provider. */
export function worstQuotaSeverity(severities: readonly QuotaSeverity[]): QuotaSeverity {
  return severities.reduce<QuotaSeverity>(
    (worst, severity) => (QUOTA_SEVERITY_RANK[severity] > QUOTA_SEVERITY_RANK[worst] ? severity : worst),
    'unknown'
  );
}

/** Stable marker so the READING (quotaSnapshot) can reconstruct whether a window was left
 *  unbound because the collector did not send account_id or because it sent one that does not
 *  exist in provider_accounts -- the table only stores account_id NULL in both cases, so the
 *  binding_note is the only signal that survives. It is ALWAYS prepended, even if the
 *  collector already brought its own note, so a custom note can never hide the
 *  "unknown account" diagnosis behind arbitrary text. */
const UNKNOWN_ACCOUNT_BINDING_PREFIX = 'cuenta desconocida: ';

function unknownAccountBindingNote(accountId: string, collectorNote: string | null | undefined): string {
  const marker = `${UNKNOWN_ACCOUNT_BINDING_PREFIX}${accountId}`;
  return collectorNote ? `${marker} — ${collectorNote}` : marker;
}

interface QuotaCollectorRow {
  host: string;
  collector_tenant: Tenant;
  collector_alias: string;
  captured_at: Date;
  received_at: Date;
  schema_version: number;
  app_version: string | null;
  provider_count: number;
  window_count: number;
}

interface QuotaProviderRow {
  host: string;
  provider: string;
  ok: boolean;
  available: boolean;
  kind: string | null;
  source: string | null;
  plan: string | null;
  note: string | null;
  effective_remaining_percent: string | number | null;
  observed_at: Date | null;
  received_at: Date;
  available_groups: string[];
  limiting_groups: string[];
}

interface QuotaWindowStateRow {
  captured_at: Date;
  received_at: Date;
  provider_ok: boolean | null;
  host: string;
  provider: string;
  group_key: string;
  window_key: string;
  label: string | null;
  used_percent: string | number | null;
  remaining_percent: string | number | null;
  used_units: string | number | null;
  limit_units: string | number | null;
  window_minutes: number | null;
  reset_at: Date | null;
  status: string | null;
  family: string | null;
  model: string | null;
  account_id: string | null;
  binding_note: string | null;
  account_label: string | null;
  account_provider: string | null;
  payer_tenant_id: Tenant | null;
  paused_until: Date | null;
  paused_reason: string | null;
}

interface QuotaHistoryRow {
  model: string | null;
  account_id: string | null;
  host: string;
  provider: string;
  group_key: string;
  window_key: string;
  bucket: Date;
  used_percent: string | number | null;
}

interface QuotaPausedAccountRow {
  account_id: string;
  provider: string;
  label: string | null;
  payer_tenant_id: Tenant;
  paused_until: Date;
  paused_reason: string | null;
}

interface QuotaHistoryPoint {
  at: string;
  used_percent: number | null;
}

interface QuotaSnapshotWindow {
  captured_at: string;
  received_at: string;
  observation_status: QuotaObservationStatus;
  window_key: string;
  label: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  used_units: number | null;
  limit_units: number | null;
  window_minutes: number | null;
  reset_at: string | null;
  reset_in_seconds: number | null;
  status: string | null;
  family: string | null;
  model: string | null;
  severity: QuotaSeverity;
  history: { bucket_seconds: number; points: QuotaHistoryPoint[] };
}

interface MutableQuotaSnapshotGroup {
  group_key: string;
  limit_id: string | null;
  account_id: string | null;
  account_label: string | null;
  account_provider: string | null;
  payer_tenant_id: Tenant | null;
  paused_until: string | null;
  paused_reason: string | null;
  min_remaining_percent: number | null;
  severity: QuotaSeverity;
  windows: QuotaSnapshotWindow[];
}

export abstract class QuotasRepository extends DeliveryControlRepository {
  /**
   * Latest quota state per (host, provider, group/account, window) plus its 24h sparkline. Self-contained
   * like topology(): validates the permission right here.
   *
   * Cross-tenant scope: the quota tables do not have a tenant_id of their own -- what exists is
   * `quota_collections.collector_tenant` (the mTLS identity that published, e.g. 'Steven:quota-collector').
   * The actor sees the collectors of every tenant readable to it (tenantReadableSql: own tenant, or read
   * and route edges the company star admits). Every table is filtered by that collector tenant, never by
   * `host`: a host is a name the collector declares, and two companies may declare the same one. An
   * account joins only inside the company of the quota state that references it.
   *
   * NEVER selects external_account_id/credential_ref/credential_ref_kind from provider_accounts: they are
   * not in the output shape anywhere in this method.
   */
  async quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const observedAt = new Date();

    const visibleTenants = await this.pool.query<{ id: Tenant }>(
      `SELECT t.id FROM tenants t WHERE ${tenantReadableSql('$1::text', 't.id')} ORDER BY t.id`,
      [actorTenant]
    );
    const visibleTenantIds = visibleTenants.rows.map((row) => row.id);

    const [collectorRows, providerRows, stateRows, historyRows, pausedRows] = await Promise.all([
      // The latest quota_collections of each visible host: it is what answers "is the
      // collector still alive?" (collectors[].stale is computed against received_at, server
      // clock).
      this.pool.query<QuotaCollectorRow>(
        `SELECT DISTINCT ON (host)
           host,collector_tenant,collector_alias,captured_at,received_at,
           schema_version,app_version,provider_count,window_count
         FROM quota_collections
         WHERE collector_tenant = ANY($1::text[])
         ORDER BY host,received_at DESC`,
        [visibleTenantIds]
      ),
      // The latest provider report per (host,provider), among the visible collections of
      // that host -- ok=false with zero windows is information and must survive here.
      this.pool.query<QuotaProviderRow>(
        `SELECT DISTINCT ON (qc.host,pr.provider)
           qc.host,pr.provider,pr.ok,pr.available,pr.kind,pr.source,pr.plan,
           pr.note,pr.effective_remaining_percent,COALESCE(pr.observed_at,qc.captured_at) AS observed_at,
           qc.received_at,pr.available_groups,pr.limiting_groups
         FROM quota_provider_reports pr
         JOIN quota_collections qc ON qc.id=pr.collection_id
         WHERE qc.collector_tenant = ANY($1::text[])
         ORDER BY qc.host,pr.provider,qc.received_at DESC`,
        [visibleTenantIds]
      ),
      // The CURRENT materialized state of each window -- the table that exists precisely so
      // this endpoint does not have to scan history on every read.
      this.pool.query<QuotaWindowStateRow>(
        `SELECT s.host,s.provider,s.group_key,s.window_key,s.label,s.captured_at,s.received_at,latest.ok AS provider_ok,
                s.used_percent,s.remaining_percent,s.used_units,s.limit_units,
                s.window_minutes,s.reset_at,s.status,s.family,s.model,
                s.account_id,s.binding_note,
                p.label AS account_label,p.provider AS account_provider,
                p.payer_tenant_id,p.paused_until,p.paused_reason
         FROM quota_window_state s
         LEFT JOIN provider_accounts p ON p.id=s.account_id AND p.company_id=s.company_id
         LEFT JOIN LATERAL (SELECT pr.ok FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id
           WHERE qc.collector_tenant=s.collector_tenant AND qc.host=s.host AND pr.provider=s.provider
             AND (pr.account_id IS NULL OR pr.account_id=s.account_id)
           ORDER BY qc.captured_at DESC,qc.received_at DESC LIMIT 1) latest ON true
         WHERE s.collector_tenant = ANY($1::text[])
         ORDER BY s.host,s.provider,s.group_key,s.window_key`,
        [visibleTenantIds]
      ),
      // Sparkline: 24h in 30-minute buckets, last observed value per bucket. DISTINCT ON is
      // not a window function -- there is no FOR SHARE/FOR UPDATE in this method in any case
      // (it is read-only), but it is documented because it is the same query family as
      // fleetActivity().
      this.pool.query<QuotaHistoryRow>(
        `WITH bucketed AS (
           SELECT host,provider,group_key,window_key,model,model_key,account_id,account_key,
                  to_timestamp(floor(extract(epoch FROM captured_at)/$2::double precision)*$2::double precision) AS bucket,
                  captured_at,used_percent
             FROM quota_window_samples
            WHERE collection_id IN (SELECT id FROM quota_collections WHERE collector_tenant = ANY($1::text[]))
              AND captured_at >= $3::timestamptz - ($4::double precision * interval '1 second')
         ), sampled AS (
           SELECT DISTINCT ON (host,provider,group_key,window_key,model_key,account_key,bucket)
                  host,provider,group_key,window_key,model,model_key,account_id,account_key,bucket,used_percent
             FROM bucketed
            ORDER BY host,provider,group_key,window_key,model_key,account_key,bucket,captured_at DESC
         )
         SELECT host,provider,group_key,window_key,model,account_id,bucket,used_percent
           FROM sampled
          ORDER BY host,provider,group_key,window_key,bucket`,
        [visibleTenantIds, DEFAULT_QUOTA_THRESHOLDS.history_bucket_seconds, observedAt, DEFAULT_QUOTA_THRESHOLDS.history_window_seconds]
      ),
      // Subscriptions currently paused whose quota state lives on a visible host. There is
      // no tenant redaction here: label/provider/payer_tenant_id are not the secret; the
      // secret is external_account_id/credential_ref, which this method never touches.
      this.pool.query<QuotaPausedAccountRow>(
        `SELECT p.id AS account_id,p.provider,p.label,p.payer_tenant_id,p.paused_until,p.paused_reason
           FROM provider_accounts p
          WHERE p.paused_until > $2::timestamptz
            AND EXISTS (SELECT 1 FROM quota_window_state s
                          WHERE s.account_id=p.id AND s.company_id=p.company_id
                            AND s.collector_tenant = ANY($1::text[]))
          ORDER BY p.provider,p.id`,
        [visibleTenantIds, observedAt]
      )
    ]);

    const historyByWindow = new Map<string, QuotaHistoryPoint[]>();
    for (const row of historyRows.rows) {
      const key = JSON.stringify([row.host, row.provider, row.group_key, row.window_key, row.model, row.account_id]);
      const points = historyByWindow.get(key) ?? [];
      points.push({ at: row.bucket.toISOString(), used_percent: row.used_percent === null ? null : Number(row.used_percent) });
      historyByWindow.set(key, points);
    }

    const groupsByProvider = new Map<string, Map<string, MutableQuotaSnapshotGroup>>();
    const unboundGroups = new Map<string, QuotaSampleUnboundGroup>();
    const noAccountDetail = 'El recolector no mandó account_id para este grupo: la muestra se guarda pero no puede pausar ninguna suscripción.';
    const unknownAccountDetail = 'El recolector mandó un account_id desconocido para este grupo: la muestra se guarda sin vincular y no puede pausar ninguna suscripción.';

    for (const row of stateRows.rows) {
      const providerKey = JSON.stringify([row.host, row.provider]);
      const providerGroups = groupsByProvider.get(providerKey) ?? new Map<string, MutableQuotaSnapshotGroup>();
      const groupIdentity = JSON.stringify([row.group_key, row.account_id]);
      let group = providerGroups.get(groupIdentity);
      if (!group) {
        group = {
          group_key: row.group_key,
          limit_id: row.group_key === 'default' ? null : row.group_key,
          account_id: null, account_label: null, account_provider: null, payer_tenant_id: null,
          paused_until: null, paused_reason: null, min_remaining_percent: null,
          severity: 'unknown', windows: []
        };
        providerGroups.set(groupIdentity, group);
        groupsByProvider.set(providerKey, providerGroups);
      }
      if (group.account_id === null && row.account_id !== null) {
        group.account_id = row.account_id;
        group.account_label = row.account_label;
        group.account_provider = row.account_provider;
        group.payer_tenant_id = row.payer_tenant_id;
        group.paused_until = row.paused_until?.toISOString() ?? null;
        group.paused_reason = row.paused_reason;
      }

      const reportedRemaining = quotaRemaining(row.remaining_percent === null ? null : Number(row.remaining_percent),
        row.used_percent === null ? null : Number(row.used_percent));
      const observationStatus = quotaObservationStatus({ receivedAt: row.received_at, capturedAt: row.captured_at, resetAt: row.reset_at,
        status: row.status, providerOk: row.provider_ok, hasValue: reportedRemaining !== null || row.used_units !== null, now: observedAt });
      const remainingPercent = observationStatus === 'ok' ? reportedRemaining : null;
      const severity = observationStatus === 'ok' ? windowSeverity(remainingPercent, row.status, DEFAULT_QUOTA_THRESHOLDS) : 'unknown';
      const historyKey = JSON.stringify([row.host, row.provider, row.group_key, row.window_key, row.model, row.account_id]);
      const points = historyByWindow.get(historyKey) ?? [];

      group.windows.push({
        captured_at: row.captured_at.toISOString(), received_at: row.received_at.toISOString(), observation_status: observationStatus,
        window_key: row.window_key,
        label: row.label,
        used_percent: row.used_percent === null ? null : Number(row.used_percent),
        remaining_percent: remainingPercent,
        used_units: row.used_units === null ? null : Number(row.used_units),
        limit_units: row.limit_units === null ? null : Number(row.limit_units),
        window_minutes: row.window_minutes,
        reset_at: row.reset_at?.toISOString() ?? null,
        // Math.max(0, ...): a reset_at that has already passed (the collector has not yet
        // resampled that window) cannot show a negative countdown.
        reset_in_seconds: row.reset_at === null ? null : Math.max(0, Math.round((row.reset_at.getTime() - observedAt.getTime()) / 1_000)),
        status: row.status, family: row.family, model: row.model,
        severity,
        history: { bucket_seconds: DEFAULT_QUOTA_THRESHOLDS.history_bucket_seconds, points: points.slice(-DEFAULT_QUOTA_THRESHOLDS.history_max_points) }
      });
      group.severity = worstQuotaSeverity([group.severity, severity]);
      if (remainingPercent !== null && (group.min_remaining_percent === null || remainingPercent < group.min_remaining_percent)) {
        group.min_remaining_percent = remainingPercent;
      }

      if (row.account_id === null) {
        const unboundKey = JSON.stringify([row.host, row.provider, row.group_key]);
        // The table only stores account_id NULL for the two reasons ("never sent" and "sent
        // one that does not exist"); the binding_note with the stable marker is the only
        // signal that survives to distinguish them on read (see unknownAccountBindingNote).
        const reason: QuotaSampleUnboundGroup['reason'] =
          row.binding_note?.startsWith(UNKNOWN_ACCOUNT_BINDING_PREFIX) === true ? 'unknown_account_id' : 'no_account_id_supplied';
        const existing = unboundGroups.get(unboundKey);
        if (existing) {
          existing.window_count += 1;
          if (reason === 'unknown_account_id') { existing.reason = reason; existing.detail = unknownAccountDetail; }
        } else {
          unboundGroups.set(unboundKey, {
            host: row.host, provider: row.provider, group_key: row.group_key, window_count: 1,
            reason, detail: reason === 'unknown_account_id' ? unknownAccountDetail : noAccountDetail
          });
        }
      }
    }

    const collectors = collectorRows.rows.map((row) => {
      const ageSeconds = Math.max(0, Math.round((observedAt.getTime() - row.received_at.getTime()) / 1_000));
      return {
        host: row.host, collector_tenant: row.collector_tenant, collector_alias: row.collector_alias,
        captured_at: row.captured_at.toISOString(), received_at: row.received_at.toISOString(),
        age_seconds: ageSeconds, stale: ageSeconds > DEFAULT_QUOTA_THRESHOLDS.stale_after_seconds,
        schema_version: row.schema_version, app_version: row.app_version,
        provider_count: row.provider_count, window_count: row.window_count
      };
    });

    const providers = providerRows.rows.map((row) => {
      const providerKey = JSON.stringify([row.host, row.provider]);
      const groups = [...(groupsByProvider.get(providerKey)?.values() ?? [])];
      const observationStatus = quotaObservationStatus({ receivedAt: row.received_at, capturedAt: row.observed_at, resetAt: null,
        status: null, providerOk: row.ok, hasValue: groups.some(group => group.windows.some(window => window.observation_status === 'ok')), now: observedAt });
      return {
        host: row.host, provider: row.provider, ok: row.ok, available: row.available,
        kind: row.kind, source: row.source, plan: row.plan, note: row.note,
        observation_status: observationStatus, received_at: row.received_at.toISOString(),
        effective_remaining_percent: observationStatus !== 'ok' || row.effective_remaining_percent === null ? null : Number(row.effective_remaining_percent),
        observed_at: row.observed_at?.toISOString() ?? null,
        age_seconds: Math.max(0, Math.round((observedAt.getTime() - row.received_at.getTime()) / 1_000)),
        available_groups: row.available_groups, limiting_groups: row.limiting_groups,
        severity: observationStatus === 'ok' ? worstQuotaSeverity(groups.map((group) => group.severity)) : 'unknown',
        groups
      };
    });

    return {
      observed_at: observedAt.toISOString(),
      thresholds: DEFAULT_QUOTA_THRESHOLDS,
      collectors,
      providers,
      unbound_groups: [...unboundGroups.values()],
      paused_accounts: pausedRows.rows.map((row) => ({
        account_id: row.account_id, provider: row.provider, label: row.label,
        payer_tenant_id: row.payer_tenant_id, paused_until: row.paused_until.toISOString(),
        paused_reason: row.paused_reason,
        automatic: row.paused_reason?.startsWith(AUTOMATIC_PAUSE_PREFIX) ?? false
      }))
    };
  }

  /**
   * Ingestion of one quota collector run (POST /v3/quotas/samples). It does NOT self-check permission --
   * the route does so before calling here, same pattern as enqueueJob(). actorTenant/actorAlias are the
   * AUTHENTICATED mTLS identity (never the body) and are stored as collector_tenant/collector_alias: these
   * rows can pause paid subscriptions, so it must be recorded who published the sample that cut off dispatch.
   *
   * All in ONE transaction: (host,captured_at) collision => 202 duplicate=true without writing anything else:
   * the collector can retry without fear of duplicating the series.
   */
  async recordQuotaSample(actorTenant: Tenant, actorAlias: string, sample: QuotaSampleRequest, transactionClient?: DatabaseClient): Promise<QuotaSampleIngestResult> {
    // Synchronous check BEFORE touching the database: a schema_version this gateway version
    // does not understand is not blindly mapped -- that is exactly how a misread sample
    // triggers the auto-pause of a healthy subscription.
    if (!(SUPPORTED_QUOTA_SCHEMA_VERSIONS as readonly number[]).includes(sample.schema_version)) {
      throw new StoreError('invalid_input', `unsupported quota schema_version: ${String(sample.schema_version)}`);
    }

    const providerCount = sample.providers.length;
    const windowCount = sample.providers.reduce((count, provider) => count + provider.windows.length, 0);

    const record = async (client: DatabaseClient): Promise<QuotaSampleIngestResult> => {
      const collectorLock = await client.query<{ acquired: boolean }>(transactionClient === undefined
        ? 'SELECT pg_advisory_xact_lock(783_003_013,hashtext($1)),true AS acquired'
        : 'SELECT pg_try_advisory_xact_lock(783_003_013,hashtext($1)) AS acquired', [JSON.stringify([actorTenant, sample.host])]);
      if (!collectorLock.rows[0]?.acquired) throw new StoreError('conflict', 'quota collector already has an active ingestion');
      const insertedCollection = await client.query<{ id: string }>(
        `INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,schema_version,app_version,provider_count,window_count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (collector_tenant,host,captured_at) DO NOTHING
         RETURNING id`,
        [sample.host, actorTenant, actorAlias, sample.captured_at, sample.schema_version, sample.app_version ?? null, providerCount, windowCount]
      );
      const collectionId = insertedCollection.rows[0]?.id;
      if (!collectionId) {
        // Collision with UNIQUE(collector_tenant,host,captured_at): a network retry from the
        // same collector. The existing id is recovered so the response stays useful, and
        // nothing is written.
        //
        const existingCollection = await client.query<{ id: string }>(
          `SELECT id FROM quota_collections WHERE collector_tenant=$1 AND host=$2 AND captured_at=$3`,
          [actorTenant, sample.host, sample.captured_at]
        );
        const existingId = existingCollection.rows[0]?.id;
        if (!existingId) throw new StoreError('conflict', 'duplicate quota collection vanished mid-transaction');
        return {
          collection_id: existingId, host: sample.host, captured_at: sample.captured_at, duplicate: true,
          accepted_providers: 0, accepted_windows: 0,
          unbound_groups: [], paused_accounts: [], resumed_accounts: [], pruned_collections: 0
        };
      }

      // account_id is sent by the COLLECTOR, never guessed by the gateway (see migration 013).
      // It is pre-validated against provider_accounts HERE, before inserting anything, because
      // inserting against a non-existent account_id would break the FK and abort the ENTIRE
      // transaction -- exactly what "an unknown account_id does not fail the POST" forbids.
      const suppliedAccountIds = new Set<string>();
      for (const provider of sample.providers) {
        if (provider.account_id != null) suppliedAccountIds.add(provider.account_id);
        for (const window of provider.windows) {
          if (window.account_id !== null && window.account_id !== undefined) suppliedAccountIds.add(window.account_id);
        }
      }
      // ...and it is ALSO required that the account be paid for by THE PUBLISHING TENANT. Without this
      // filter, an operator from another tenant could declare someone else's account_id and, via the
      // quota-exhausted auto-pause, leave the agents of a tenant that is not theirs without dispatch:
      // a well-formed POST could shut down another tenant's fleet. The unknown account no longer
      // breaks the POST (it is stored unbound), so a foreign account takes exactly that same path:
      // the sample is stored, not bound, and the reason is written into unbound_groups.
      const knownAccountRows = await client.query<{ id: string }>(
        `SELECT id FROM provider_accounts WHERE id = ANY($1::text[]) AND company_id = (SELECT company_id FROM tenants WHERE id=$2)`,
        [[...suppliedAccountIds], actorTenant]
      );
      const knownAccountIds = new Set(knownAccountRows.rows.map((row) => row.id));

      const unboundGroups = new Map<string, QuotaSampleUnboundGroup>();
      const noAccountDetail = 'El recolector no mandó account_id para este grupo: la muestra se guarda pero no puede pausar ninguna suscripción.';
      const unknownAccountDetail = 'El recolector mandó un account_id desconocido para este grupo: la muestra se guarda sin vincular y no puede pausar ninguna suscripción.';

      for (const provider of sample.providers) {
        await client.query(
          `INSERT INTO quota_provider_reports(collection_id,provider,ok,available,kind,source,plan,note,effective_remaining_percent,observed_at,available_groups,limiting_groups,account_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)`,
          [
            collectionId, provider.provider, provider.ok, provider.available,
            provider.kind ?? null, provider.source ?? null, provider.plan ?? null, provider.note ?? null,
            provider.effective_remaining_percent ?? null, provider.observed_at ?? null,
            JSON.stringify(provider.available_groups), JSON.stringify(provider.limiting_groups),
            provider.account_id != null && knownAccountIds.has(provider.account_id) ? provider.account_id : null
          ]
        );

        for (const window of provider.windows) {
          let finalAccountId: string | null;
          let finalBindingNote: string | null;
          let unboundReason: QuotaSampleUnboundGroup['reason'] | null = null;

          if (window.account_id === null || window.account_id === undefined) {
            finalAccountId = null;
            finalBindingNote = window.binding_note ?? null;
            unboundReason = 'no_account_id_supplied';
          } else if (!knownAccountIds.has(window.account_id)) {
            finalAccountId = null;
            // Stable marker ALWAYS PREPENDED, even if the collector sent its own note: if it
            // were not so, a custom note could hide "unknown account" behind arbitrary text,
            // and quotaSnapshot() would no longer be able to reconstruct the real reason.
            finalBindingNote = unknownAccountBindingNote(window.account_id, window.binding_note);
            unboundReason = 'unknown_account_id';
          } else {
            finalAccountId = window.account_id;
            finalBindingNote = window.binding_note ?? null;
          }

          if (unboundReason !== null) {
            const unboundKey = JSON.stringify([sample.host, provider.provider, window.group_key]);
            const existing = unboundGroups.get(unboundKey);
            if (existing) {
              existing.window_count += 1;
              if (unboundReason === 'unknown_account_id') { existing.reason = unboundReason; existing.detail = unknownAccountDetail; }
            } else {
              unboundGroups.set(unboundKey, {
                host: sample.host, provider: provider.provider, group_key: window.group_key, window_count: 1,
                reason: unboundReason, detail: unboundReason === 'unknown_account_id' ? unknownAccountDetail : noAccountDetail
              });
            }
          }

          await client.query(
            `INSERT INTO quota_window_samples(collection_id,provider,group_key,window_key,host,captured_at,label,used_percent,remaining_percent,used_units,limit_units,window_minutes,reset_at,status,family,model,account_id,binding_note)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              collectionId, provider.provider, window.group_key, window.window_key, sample.host, window.observed_at ?? provider.observed_at ?? sample.captured_at,
              window.label ?? null, window.used_percent ?? null, window.remaining_percent ?? null,
              window.used_units ?? null, window.limit_units ?? null, window.window_minutes ?? null,
              window.reset_at ?? null, window.status ?? null, window.family ?? null, window.model ?? null,
              finalAccountId, finalBindingNote
            ]
          );
        }
      }

      await client.query(
        `INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,collection_id,captured_at,label,
           used_percent,remaining_percent,used_units,limit_units,window_minutes,reset_at,status,family,model,account_id,binding_note)
         SELECT $2,incoming.host,incoming.provider,incoming.group_key,incoming.window_key,incoming.collection_id,
           incoming.captured_at,incoming.label,incoming.used_percent,incoming.remaining_percent,incoming.used_units,
           incoming.limit_units,incoming.window_minutes,incoming.reset_at,incoming.status,incoming.family,incoming.model,
           incoming.account_id,incoming.binding_note
         FROM quota_window_samples incoming
         LEFT JOIN quota_window_state previous ON previous.collector_tenant=$2 AND previous.host=incoming.host
           AND previous.provider=incoming.provider AND previous.group_key=incoming.group_key
           AND previous.window_key=incoming.window_key AND previous.model_key=incoming.model_key
           AND previous.account_key=incoming.account_key
         WHERE incoming.collection_id=$1 AND (previous.collector_tenant IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM quota_window_state current
           WHERE current.collector_tenant=$2 AND current.host=incoming.host AND current.provider=incoming.provider
             AND current.group_key=incoming.group_key AND current.window_key=incoming.window_key
             AND current.captured_at>=incoming.captured_at))
         ON CONFLICT (collector_tenant,host,provider,group_key,window_key,model_key,account_key) DO UPDATE SET
           collection_id=EXCLUDED.collection_id,captured_at=EXCLUDED.captured_at,received_at=now(),label=EXCLUDED.label,
           used_percent=EXCLUDED.used_percent,remaining_percent=EXCLUDED.remaining_percent,used_units=EXCLUDED.used_units,
           limit_units=EXCLUDED.limit_units,window_minutes=EXCLUDED.window_minutes,reset_at=EXCLUDED.reset_at,
           status=EXCLUDED.status,family=EXCLUDED.family,model=EXCLUDED.model,account_id=EXCLUDED.account_id,binding_note=EXCLUDED.binding_note
         WHERE quota_window_state.captured_at<EXCLUDED.captured_at`,
        [collectionId, actorTenant]
      );
      await client.query(
        `DELETE FROM quota_window_state obsolete USING quota_window_state accepted
         WHERE accepted.collection_id=$1 AND obsolete.collector_tenant=accepted.collector_tenant
           AND obsolete.host=accepted.host AND obsolete.provider=accepted.provider
           AND obsolete.group_key=accepted.group_key AND obsolete.window_key=accepted.window_key
           AND obsolete.captured_at<accepted.captured_at AND NOT EXISTS (
             SELECT 1 FROM quota_window_samples incoming WHERE incoming.collection_id=$1
               AND incoming.provider=obsolete.provider AND incoming.group_key=obsolete.group_key
               AND incoming.window_key=obsolete.window_key AND incoming.model_key=obsolete.model_key
               AND incoming.account_key=obsolete.account_key)`,
        [collectionId]
      );

      // Auto-pause: only BOUND accounts (account_id NOT NULL via the JOIN) and only up to
      // the reported reset -- never indefinite. Bounded to this collection_id: a stale run
      // rejected by the anti-regression guard above cannot trigger a pause based on stale data.
      const pausedAccountRows = await client.query<{ account_id: string; provider: string; group_key: string; window_key: string; paused_until: Date }>(
        `UPDATE provider_accounts p
            SET paused_until = GREATEST(COALESCE(p.paused_until, now()), s.reset_at),
                paused_reason = $2||s.provider||'/'||s.group_key||'/'||s.window_key,
                updated_at = now()
           FROM quota_window_state s
          WHERE s.account_id = p.id AND s.collection_id = $1
            AND (s.remaining_percent <= 0 OR s.used_percent >= 100 OR s.status = 'rate-limited')
            AND s.reset_at > now() AND s.model IS NULL
            AND (s.status IS NULL OR s.status NOT IN ('unknown','error','stale'))
            AND s.received_at>now()-interval '15 minutes'
            AND s.captured_at>now()-interval '15 minutes' AND s.captured_at<=now()+interval '60 seconds'
            AND (p.paused_reason IS NULL OR starts_with(p.paused_reason,$2))
            AND EXISTS (SELECT 1 FROM quota_provider_reports pr WHERE pr.collection_id=$1 AND pr.provider=s.provider AND pr.ok)
         RETURNING p.id AS account_id, p.provider, s.group_key, s.window_key, p.paused_until`,
        [collectionId, AUTOMATIC_PAUSE_PREFIX]
      );
      const pausedAccounts: QuotaSamplePausedAccount[] = pausedAccountRows.rows.map((row) => ({
        account_id: row.account_id, provider: row.provider, group_key: row.group_key,
        window_key: row.window_key, paused_until: row.paused_until.toISOString()
      }));

      // Company-wide auto-resume (not bounded to this collection_id) on purpose: if another provider of the
      // same run, or a previous run, already left an account healthy, it is lifted as soon as it is detected,
      // not only when THAT account shows up again in a POST. Only accounts of the collector's company move and
      // are reported back to it; the automatic pause prefix clause prevents overwriting a manual pause.
      const resumedAccountRows = await client.query<{ account_id: string; provider: string }>(
        `UPDATE provider_accounts p
            SET paused_until = NULL, paused_reason = NULL, updated_at = now()
          WHERE starts_with(p.paused_reason, $1)
            AND p.company_id = (SELECT collector.company_id FROM tenants collector WHERE collector.id = $2)
            AND (p.paused_until <= now() OR (
              EXISTS (SELECT 1 FROM quota_window_state s JOIN quota_provider_reports pr ON pr.collection_id=s.collection_id AND pr.provider=s.provider
                WHERE s.account_id=p.id AND s.collection_id=$3 AND pr.ok AND s.received_at>now()-interval '15 minutes'
                  AND s.captured_at>now()-interval '15 minutes' AND s.captured_at<=now()+interval '60 seconds'
                  AND (s.status IS NULL OR s.status NOT IN ('unknown','error','stale'))
                  AND (s.remaining_percent>0 OR s.used_percent<100))
              AND NOT EXISTS (SELECT 1 FROM quota_window_state s WHERE s.account_id=p.id
                AND (s.reset_at IS NULL OR s.reset_at>now())
                AND (s.received_at<=now()-interval '15 minutes' OR s.captured_at<=now()-interval '15 minutes'
                  OR s.captured_at>now()+interval '60 seconds' OR s.status IN ('rate-limited','unknown','error','stale')
                  OR COALESCE(s.remaining_percent,100-s.used_percent,0)<=0))))
         RETURNING p.id AS account_id, p.provider`,
        [AUTOMATIC_PAUSE_PREFIX, actorTenant, collectionId]
      );
      const resumedAccounts: QuotaSampleResumedAccount[] = resumedAccountRows.rows.map((row) => ({
        account_id: row.account_id, provider: row.provider
      }));

      // Bounded retention (LIMIT 500) so a single POST never triggers an unbounded DELETE. A collector only
      // ages out the history of its own company (its own tenant when it has none): a sample of one company
      // never deletes another's rows. A company whose collectors went silent stops growing, so nothing piles up.
      const prunedCollections = await client.query<{ pruned: number }>(
        `WITH pruned AS (
           DELETE FROM quota_collections WHERE ctid IN (
             SELECT collection.ctid FROM quota_collections collection
              WHERE collection.received_at < now() - interval '30 days'
                AND (collection.collector_tenant = $1 OR collection.collector_tenant IN (
                  SELECT peer.id FROM tenants peer JOIN tenants actor ON actor.company_id = peer.company_id WHERE actor.id = $1))
              ORDER BY collection.received_at LIMIT 500
           ) RETURNING 1
         )
         SELECT count(*)::int AS pruned FROM pruned`,
        [actorTenant]
      );

      return {
        collection_id: collectionId, host: sample.host, captured_at: sample.captured_at, duplicate: false,
        accepted_providers: providerCount, accepted_windows: windowCount,
        unbound_groups: [...unboundGroups.values()], paused_accounts: pausedAccounts, resumed_accounts: resumedAccounts,
        pruned_collections: prunedCollections.rows[0]?.pruned ?? 0
      };
    };
    return transactionClient === undefined ? withTransaction(this.pool, record) : record(transactionClient);
  }
}

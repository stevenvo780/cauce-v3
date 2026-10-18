import type { QuotaSampleRequest, Tenant } from '@cauce/protocol';
import { SUPPORTED_QUOTA_SCHEMA_VERSIONS } from '@cauce/protocol';
import { AUTOMATIC_PAUSE_PREFIX } from '../accounts.js';
import { withTransaction, type DatabaseClient } from '../db.js';
import { DeliveryControlRepository } from './deliveries/control.js';
import { StoreError } from './errors.js';

// ============================================================================================
// AI subscription quotas (POST /v3/quotas/samples). See
// packages/store/migrations/013_quota_observation.sql for the why behind the four tables.
// ============================================================================================

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

/** Stable marker so a reader can reconstruct whether a window was left
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

export abstract class QuotasRepository extends DeliveryControlRepository {
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
            // and a reader would no longer be able to reconstruct the real reason.
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

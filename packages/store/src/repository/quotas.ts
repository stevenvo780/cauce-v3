import type { QuotaSampleRequest, Tenant } from '@cauce/protocol';
import { SUPPORTED_QUOTA_SCHEMA_VERSIONS } from '@cauce/protocol';
import { withTransaction } from '../db.js';
import { DeliveryControlRepository } from './deliveries/control.js';
import { StoreError } from './errors.js';

// ============================================================================================
// Cuotas de suscripciones de IA (GET /v3/console/quotas, POST /v3/quotas/samples). Ver
// packages/store/migrations/013_quota_observation.sql para el porqué de las cuatro tablas.
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
  stale_after_seconds: 900,
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

/** Pura y testeable sin Postgres, mismo motivo que agentWorkState(): decide si el operador ve
 *  "todo bien" o "se está por agotar", así que es la parte que necesita un test de verdad. */
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

/** Severidad de un grupo/proveedor = la peor entre sus partes: un sólo grupo agotado no puede
 *  quedar escondido detrás de otros grupos sanos del mismo proveedor. */
export function worstQuotaSeverity(severities: readonly QuotaSeverity[]): QuotaSeverity {
  return severities.reduce<QuotaSeverity>(
    (worst, severity) => (QUOTA_SEVERITY_RANK[severity] > QUOTA_SEVERITY_RANK[worst] ? severity : worst),
    'unknown'
  );
}

/** Marcador estable para poder reconstruir, en la LECTURA (quotaSnapshot), si una ventana quedó
 *  sin atar porque el recolector no mandó account_id o porque mandó uno que no existe en
 *  provider_accounts -- la tabla sólo guarda account_id NULL en los dos casos, así que el
 *  binding_note es la única señal que sobrevive. Se antepone SIEMPRE, incluso si el recolector
 *  ya traía su propia nota, para que una nota custom nunca pueda esconder el diagnóstico
 *  "cuenta desconocida" detrás de un texto arbitrario. */
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
   * Último estado de cuota por (host, proveedor, grupo/cuenta, ventana) más su sparkline de 24h.
   * Self-contained como topology(): valida el permiso acá mismo.
   *
   * Alcance cross-tenant: las tablas de cuota no tienen tenant_id propio -- lo que existe es
   * `quota_collections.collector_tenant` (la identidad mTLS que publicó, ej.
   * 'Steven:quota-collector'). Se resuelve igual que topology()/fleetActivity() (tenant propio +
   * acl_edges allow_read) para decidir qué TENANTS puede ver el actor, y de ahí se deriva qué
   * HOSTS son visibles (todo host cuya última corrida fue publicada por un tenant visible);
   * `quota_provider_reports`/`quota_window_samples`/`quota_window_state` no tienen
   * collector_tenant propio, así que se filtran por host, que es la clave natural compartida.
   *
   * NUNCA selecciona external_account_id/credential_ref/credential_ref_kind de
   * provider_accounts: no están en el shape de salida en ningún lado de este método.
   */
  async quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const observedAt = new Date();

    const visibleTenants = await this.pool.query<{ id: Tenant }>(
      `SELECT t.id FROM tenants t WHERE t.id=$1 OR EXISTS (
         SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=t.id
           AND a.enabled AND a.allow_read
       ) ORDER BY t.id`,
      [actorTenant]
    );
    // El aislamiento es por TENANT, nunca por el nombre de host: `host` es una cadena que declara
    // el propio recolector, asi que dos tenants que usen el mismo nombre compartirian panel. Se
    // conserva `visibleHosts` para las lecturas de tablas que aun no llevan el tenant (el historico
    // se acota ademas por su collection), pero el filtro que MANDA es el de tenant.
    const visibleTenantIds = visibleTenants.rows.map((row) => row.id);
    const visibleHostsResult = await this.pool.query<{ host: string }>(
      `SELECT DISTINCT host FROM quota_collections
       WHERE collector_tenant = ANY($1::text[])
       ORDER BY host`,
      [visibleTenantIds]
    );
    const visibleHosts = visibleHostsResult.rows.map((row) => row.host);

    const [collectorRows, providerRows, stateRows, historyRows, pausedRows] = await Promise.all([
      // El último quota_collections de cada host visible: es el que responde "¿el recolector
      // sigue vivo?" (collectors[].stale se calcula contra received_at, reloj del servidor).
      this.pool.query<QuotaCollectorRow>(
        `SELECT DISTINCT ON (host)
           host,collector_tenant,collector_alias,captured_at,received_at,
           schema_version,app_version,provider_count,window_count
         FROM quota_collections
         WHERE host = ANY($1::text[])
         ORDER BY host,received_at DESC`,
        [visibleHosts]
      ),
      // El último reporte de proveedor por (host,provider), entre las collections visibles de
      // ese host -- ok=false con cero ventanas es información y tiene que sobrevivir acá.
      this.pool.query<QuotaProviderRow>(
        `SELECT DISTINCT ON (qc.host,pr.provider)
           qc.host,pr.provider,pr.ok,pr.available,pr.kind,pr.source,pr.plan,
           pr.note,pr.effective_remaining_percent,pr.observed_at,
           qc.received_at,pr.available_groups,pr.limiting_groups
         FROM quota_provider_reports pr
         JOIN quota_collections qc ON qc.id=pr.collection_id
         WHERE qc.host = ANY($1::text[])
         ORDER BY qc.host,pr.provider,qc.received_at DESC`,
        [visibleHosts]
      ),
      // El estado ACTUAL materializado de cada ventana -- la tabla que existe justamente para
      // que este endpoint no tenga que escanear el histórico en cada lectura.
      this.pool.query<QuotaWindowStateRow>(
        `SELECT s.host,s.provider,s.group_key,s.window_key,s.label,
                s.used_percent,s.remaining_percent,s.used_units,s.limit_units,
                s.window_minutes,s.reset_at,s.status,s.family,s.model,
                s.account_id,s.binding_note,
                p.label AS account_label,p.provider AS account_provider,
                p.payer_tenant_id,p.paused_until,p.paused_reason
         FROM quota_window_state s
         LEFT JOIN provider_accounts p ON p.id=s.account_id
         WHERE s.collector_tenant = ANY($1::text[])
         ORDER BY s.host,s.provider,s.group_key,s.window_key`,
        [visibleTenantIds]
      ),
      // Sparkline: 24h en cubetas de 30min, último valor observado por cubeta. DISTINCT ON no es
      // una función de ventana -- no hay ningún FOR SHARE/FOR UPDATE en este método de cualquier
      // forma (es de sólo lectura), pero queda documentado porque es la misma familia de
      // consulta que fleetActivity().
      this.pool.query<QuotaHistoryRow>(
        `WITH bucketed AS (
           SELECT host,provider,group_key,window_key,
                  to_timestamp(floor(extract(epoch FROM captured_at)/$2::double precision)*$2::double precision) AS bucket,
                  captured_at,used_percent
             FROM quota_window_samples
            WHERE collection_id IN (SELECT id FROM quota_collections WHERE collector_tenant = ANY($1::text[]))
              AND captured_at >= $3::timestamptz - ($4::double precision * interval '1 second')
         ), sampled AS (
           SELECT DISTINCT ON (host,provider,group_key,window_key,bucket)
                  host,provider,group_key,window_key,bucket,used_percent
             FROM bucketed
            ORDER BY host,provider,group_key,window_key,bucket,captured_at DESC
         )
         SELECT host,provider,group_key,window_key,bucket,used_percent
           FROM sampled
          ORDER BY host,provider,group_key,window_key,bucket`,
        [visibleTenantIds, DEFAULT_QUOTA_THRESHOLDS.history_bucket_seconds, observedAt, DEFAULT_QUOTA_THRESHOLDS.history_window_seconds]
      ),
      // Suscripciones actualmente pausadas cuyo estado de cuota vive en un host visible. No hay
      // redacción de tenant acá: label/provider/payer_tenant_id no son el secreto, el secreto es
      // external_account_id/credential_ref, que este método nunca toca.
      this.pool.query<QuotaPausedAccountRow>(
        `SELECT p.id AS account_id,p.provider,p.label,p.payer_tenant_id,p.paused_until,p.paused_reason
           FROM provider_accounts p
          WHERE p.paused_until > $2::timestamptz
            AND EXISTS (SELECT 1 FROM quota_window_state s
                          WHERE s.account_id=p.id AND s.collector_tenant = ANY($1::text[]))
          ORDER BY p.provider,p.id`,
        [visibleTenantIds, observedAt]
      )
    ]);

    const historyByWindow = new Map<string, QuotaHistoryPoint[]>();
    for (const row of historyRows.rows) {
      const key = JSON.stringify([row.host, row.provider, row.group_key, row.window_key]);
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
      let group = providerGroups.get(row.group_key);
      if (!group) {
        group = {
          group_key: row.group_key,
          limit_id: row.group_key === 'default' ? null : row.group_key,
          account_id: null, account_label: null, account_provider: null, payer_tenant_id: null,
          paused_until: null, paused_reason: null, min_remaining_percent: null,
          severity: 'unknown', windows: []
        };
        providerGroups.set(row.group_key, group);
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

      const remainingPercent = row.remaining_percent === null ? null : Number(row.remaining_percent);
      const severity = windowSeverity(remainingPercent, row.status, DEFAULT_QUOTA_THRESHOLDS);
      const historyKey = JSON.stringify([row.host, row.provider, row.group_key, row.window_key]);
      const points = historyByWindow.get(historyKey) ?? [];

      group.windows.push({
        window_key: row.window_key,
        label: row.label,
        used_percent: row.used_percent === null ? null : Number(row.used_percent),
        remaining_percent: remainingPercent,
        used_units: row.used_units === null ? null : Number(row.used_units),
        limit_units: row.limit_units === null ? null : Number(row.limit_units),
        window_minutes: row.window_minutes === null ? null : Number(row.window_minutes),
        reset_at: row.reset_at?.toISOString() ?? null,
        // Math.max(0, ...): un reset_at que ya pasó (el recolector todavía no volvió a
        // muestrear esa ventana) no puede mostrar una cuenta regresiva negativa.
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
        // La tabla sólo guarda account_id NULL para los dos motivos ("nunca lo mandaron" y
        // "mandaron uno que no existe"); el binding_note con el marcador estable es la única
        // señal que sobrevive para distinguirlos en la lectura (ver unknownAccountBindingNote).
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
        schema_version: Number(row.schema_version), app_version: row.app_version,
        provider_count: Number(row.provider_count), window_count: Number(row.window_count)
      };
    });

    const providers = providerRows.rows.map((row) => {
      const providerKey = JSON.stringify([row.host, row.provider]);
      const groups = [...(groupsByProvider.get(providerKey)?.values() ?? [])];
      return {
        host: row.host, provider: row.provider, ok: row.ok, available: row.available,
        kind: row.kind, source: row.source, plan: row.plan, note: row.note,
        effective_remaining_percent: row.effective_remaining_percent === null ? null : Number(row.effective_remaining_percent),
        observed_at: row.observed_at?.toISOString() ?? null,
        age_seconds: Math.max(0, Math.round((observedAt.getTime() - row.received_at.getTime()) / 1_000)),
        available_groups: row.available_groups, limiting_groups: row.limiting_groups,
        severity: worstQuotaSeverity(groups.map((group) => group.severity)),
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
        paused_reason: row.paused_reason, automatic: row.paused_reason?.startsWith('quota_exhausted:') ?? false
      }))
    };
  }

  /**
   * Ingesta de una corrida del recolector de cuotas (POST /v3/quotas/samples). NO autochequea
   * permiso -- lo hace la ruta antes de llamar acá, mismo patrón que enqueueJob(). actorTenant/
   * actorAlias son la identidad mTLS AUTENTICADA (nunca el cuerpo) y se graban como
   * collector_tenant/collector_alias: estas filas pueden pausar suscripciones pagas, así que
   * tiene que quedar registrado quién publicó la muestra que cortó el despacho.
   *
   * Todo en UNA transacción: colisión de (host,captured_at) => 202 duplicate=true sin escribir
   * nada más: el recolector puede reintentar sin miedo a duplicar la serie.
   */
  async recordQuotaSample(actorTenant: Tenant, actorAlias: string, sample: QuotaSampleRequest): Promise<QuotaSampleIngestResult> {
    // Chequeo síncrono ANTES de tocar la base: un schema_version que esta versión del gateway no
    // entiende no se mapea a ciegas -- eso es exactamente cómo una muestra mal leída dispara la
    // auto-pausa de una suscripción sana.
    if (!(SUPPORTED_QUOTA_SCHEMA_VERSIONS as readonly number[]).includes(sample.schema_version)) {
      throw new StoreError('invalid_input', `unsupported quota schema_version: ${sample.schema_version}`);
    }

    const providerCount = sample.providers.length;
    const windowCount = sample.providers.reduce((count, provider) => count + provider.windows.length, 0);

    return withTransaction(this.pool, async (client) => {
      const insertedCollection = await client.query<{ id: string }>(
        `INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,schema_version,app_version,provider_count,window_count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (collector_tenant,host,captured_at) DO NOTHING
         RETURNING id`,
        [sample.host, actorTenant, actorAlias, sample.captured_at, sample.schema_version, sample.app_version ?? null, providerCount, windowCount]
      );
      const collectionId = insertedCollection.rows[0]?.id;
      if (!collectionId) {
        // Colisión con UNIQUE(collector_tenant,host,captured_at): un reintento de red del mismo
        // recolector. Se recupera el id existente para que la respuesta siga siendo útil, y no se
        // escribe nada.
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

      // account_id lo manda el RECOLECTOR, nunca lo adivina el gateway (ver migración 013). Se
      // pre-valida contra provider_accounts ACÁ, antes de insertar nada, porque insertar contra
      // un account_id inexistente rompería la FK y abortaría TODA la transacción -- justo lo que
      // "un account_id desconocido no tira el POST" prohíbe.
      const suppliedAccountIds = new Set<string>();
      for (const provider of sample.providers) {
        for (const window of provider.windows) {
          if (window.account_id !== null && window.account_id !== undefined) suppliedAccountIds.add(window.account_id);
        }
      }
      // …y se exige ADEMAS que la cuenta la pague EL TENANT QUE PUBLICA. Sin este filtro, un
      // operador de otro tenant podia declarar el account_id ajeno y, via la auto-pausa por cuota
      // agotada, dejar sin despacho a los agentes de un tenant que no es el suyo: un POST bien
      // formado apagaba la flota de otro. La cuenta desconocida YA no rompe el POST (se guarda sin
      // vincular), asi que la ajena toma exactamente ese mismo camino: se guarda la muestra, no se
      // vincula, y el motivo queda escrito en unbound_groups.
      const knownAccountRows = await client.query<{ id: string }>(
        `SELECT id FROM provider_accounts WHERE id = ANY($1::text[]) AND payer_tenant_id = $2`,
        [[...suppliedAccountIds], actorTenant]
      );
      const knownAccountIds = new Set(knownAccountRows.rows.map((row) => row.id));

      const unboundGroups = new Map<string, QuotaSampleUnboundGroup>();
      const noAccountDetail = 'El recolector no mandó account_id para este grupo: la muestra se guarda pero no puede pausar ninguna suscripción.';
      const unknownAccountDetail = 'El recolector mandó un account_id desconocido para este grupo: la muestra se guarda sin vincular y no puede pausar ninguna suscripción.';

      for (const provider of sample.providers) {
        await client.query(
          `INSERT INTO quota_provider_reports(collection_id,provider,ok,available,kind,source,plan,note,effective_remaining_percent,observed_at,available_groups,limiting_groups)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
          [
            collectionId, provider.provider, provider.ok, provider.available,
            provider.kind ?? null, provider.source ?? null, provider.plan ?? null, provider.note ?? null,
            provider.effective_remaining_percent ?? null, provider.observed_at ?? null,
            JSON.stringify(provider.available_groups), JSON.stringify(provider.limiting_groups)
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
            // Marcador estable ANTEPUESTO siempre, aunque el recolector haya mandado su propia
            // nota: si no fuera así, una nota custom podría esconder "cuenta desconocida" detrás
            // de texto arbitrario y quotaSnapshot() ya no podría reconstruir el motivo real.
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
              collectionId, provider.provider, window.group_key, window.window_key, sample.host, sample.captured_at,
              window.label ?? null, window.used_percent ?? null, window.remaining_percent ?? null,
              window.used_units ?? null, window.limit_units ?? null, window.window_minutes ?? null,
              window.reset_at ?? null, window.status ?? null, window.family ?? null, window.model ?? null,
              finalAccountId, finalBindingNote
            ]
          );

          // Guarda anti-retroceso en el WHERE: una corrida vieja que llega tarde (reintento de
          // red, cola atascada) no puede pisar un estado más nuevo que ya se leyó.
          await client.query(
            `INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,collection_id,captured_at,label,used_percent,remaining_percent,used_units,limit_units,window_minutes,reset_at,status,family,model,account_id,binding_note)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (collector_tenant,host,provider,group_key,window_key) DO UPDATE SET
               collection_id=EXCLUDED.collection_id, captured_at=EXCLUDED.captured_at, received_at=now(),
               label=EXCLUDED.label, used_percent=EXCLUDED.used_percent, remaining_percent=EXCLUDED.remaining_percent,
               used_units=EXCLUDED.used_units, limit_units=EXCLUDED.limit_units, window_minutes=EXCLUDED.window_minutes,
               reset_at=EXCLUDED.reset_at, status=EXCLUDED.status, family=EXCLUDED.family, model=EXCLUDED.model,
               account_id=EXCLUDED.account_id, binding_note=EXCLUDED.binding_note
             WHERE quota_window_state.captured_at < EXCLUDED.captured_at`,
            [
              actorTenant, sample.host, provider.provider, window.group_key, window.window_key, collectionId, sample.captured_at,
              window.label ?? null, window.used_percent ?? null, window.remaining_percent ?? null,
              window.used_units ?? null, window.limit_units ?? null, window.window_minutes ?? null,
              window.reset_at ?? null, window.status ?? null, window.family ?? null, window.model ?? null,
              finalAccountId, finalBindingNote
            ]
          );
        }
      }

      // Auto-pausa: sólo cuentas ATADAS (account_id NOT NULL vía el JOIN) y sólo hasta el reset
      // informado -- nunca indefinida. Acotada a esta collection_id: una corrida vieja rechazada
      // por la guarda anti-retroceso de arriba no puede disparar una pausa basada en datos viejos.
      const pausedAccountRows = await client.query<{ account_id: string; provider: string; group_key: string; window_key: string; paused_until: Date }>(
        `UPDATE provider_accounts p
            SET paused_until = GREATEST(COALESCE(p.paused_until, now()), s.reset_at),
                paused_reason = 'quota_exhausted:'||s.provider||'/'||s.group_key||'/'||s.window_key,
                updated_at = now()
           FROM quota_window_state s
          WHERE s.account_id = p.id AND s.collection_id = $1
            AND (s.remaining_percent <= 0 OR s.status = 'rate-limited')
            AND s.reset_at IS NOT NULL
         RETURNING p.id AS account_id, p.provider, s.group_key, s.window_key, p.paused_until`,
        [collectionId]
      );
      const pausedAccounts: QuotaSamplePausedAccount[] = pausedAccountRows.rows.map((row) => ({
        account_id: row.account_id, provider: row.provider, group_key: row.group_key,
        window_key: row.window_key, paused_until: row.paused_until.toISOString()
      }));

      // Auto-reanudación GLOBAL (no acotada a esta collection_id) a propósito: si otro proveedor
      // de la misma corrida, o una corrida anterior, ya dejó una cuenta sana, tiene que levantarse
      // apenas se detecte, no recién cuando ESA cuenta puntual vuelva a aparecer en un POST. El
      // WHERE paused_reason LIKE 'quota_exhausted:%' es lo que impide pisar una pausa manual.
      const resumedAccountRows = await client.query<{ account_id: string; provider: string }>(
        `UPDATE provider_accounts p
            SET paused_until = NULL, paused_reason = NULL, updated_at = now()
          WHERE p.paused_reason LIKE 'quota_exhausted:%'
            AND NOT EXISTS (
              SELECT 1 FROM quota_window_state s
               WHERE s.account_id = p.id AND (s.remaining_percent <= 0 OR s.status = 'rate-limited')
            )
         RETURNING p.id AS account_id, p.provider`
      );
      const resumedAccounts: QuotaSampleResumedAccount[] = resumedAccountRows.rows.map((row) => ({
        account_id: row.account_id, provider: row.provider
      }));

      // Retención acotada (LIMIT 500) para que un solo POST nunca dispare un DELETE ilimitado.
      const prunedCollections = await client.query(
        `DELETE FROM quota_collections WHERE ctid IN (
           SELECT ctid FROM quota_collections
            WHERE received_at < now() - interval '30 days' ORDER BY received_at LIMIT 500
         )`
      );

      return {
        collection_id: collectionId, host: sample.host, captured_at: sample.captured_at, duplicate: false,
        accepted_providers: providerCount, accepted_windows: windowCount,
        unbound_groups: [...unboundGroups.values()], paused_accounts: pausedAccounts, resumed_accounts: resumedAccounts,
        pruned_collections: prunedCollections.rowCount ?? 0
      };
    });
  }
}

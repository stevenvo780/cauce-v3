import { z } from 'zod';

// ---------------------------------------------------------------------------
// Quota ingestion: POST /v3/quotas/samples. Wire contract for the out-of-band
// quota collector (get_ai_quotas) that runs on kratos and inside agent
// containers, well away from the gateway. Deliberately shaped like
// NotifyRequestSchema, not AuthenticatedPublishSchema: no tenant/actor/session
// field exists here because the collector's identity comes from its mTLS
// certificate, never from the body -- a machine caller cannot claim to be
// publishing on behalf of a tenant it does not authenticate as.
// ---------------------------------------------------------------------------
export const QuotaHostSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const QuotaProviderNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
export const QuotaGroupKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const QuotaWindowKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const QuotaStatusSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const QuotaAccountIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/**
 * MAJOR schema versions this gateway knows how to interpret. get_ai_quotas reports
 * schemaVersion 2 today (see docs handed to the collector implementer). A future
 * incompatible reshape bumps this number, and an unknown value MUST be rejected
 * with 422 rather than mapped field-by-field: a misread window that claims 0%
 * remaining is what triggers the auto-pause of a real, paying subscription.
 */
export const SUPPORTED_QUOTA_SCHEMA_VERSIONS = [1, 2] as const;

export const QuotaWindowSampleSchema = z.object({
  // Normalized upstream by the collector: group_key = window.limitId ?? 'default',
  // window_key = window.key. The gateway trusts this split rather than recomputing
  // it, because the collector is the only component that saw the raw CLI output.
  group_key: QuotaGroupKeySchema,
  window_key: QuotaWindowKeySchema,
  label: z.string().min(1).max(64).nullable().optional(),
  used_percent: z.number().min(0).max(100).nullable().optional(),
  remaining_percent: z.number().min(0).max(100).nullable().optional(),
  used_units: z.number().int().nonnegative().nullable().optional(),
  limit_units: z.number().int().positive().nullable().optional(),
  window_minutes: z.number().int().positive().nullable().optional(),
  // Absolute instant, not a resetInSeconds delta: a relative countdown goes stale
  // the moment it is persisted and would mislead every later read of the history.
  reset_at: z.iso.datetime({ offset: true }).nullable().optional(),
  status: QuotaStatusSchema.nullable().optional(),
  family: z.string().min(1).max(64).nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  // The subscription this window draws from, when the collector knows it. Absent
  // or unknown to the registry is not an error: the sample is still stored, with
  // account_id nulled server-side and surfaced under unbound_groups[].
  account_id: QuotaAccountIdSchema.nullable().optional(),
  binding_note: z.string().min(1).max(128).nullable().optional()
}).strict().refine(
  (window) => window.used_percent != null || window.remaining_percent != null || window.used_units != null,
  { message: 'a window sample needs at least one of used_percent, remaining_percent or used_units' }
);

export const QuotaProviderReportSchema = z.object({
  provider: QuotaProviderNameSchema,
  // ok=false with zero windows is information ("the CLI stopped answering"), not
  // absence of information ("the provider was not used") -- the two are opposite
  // diagnoses and this shape is what keeps them distinguishable.
  ok: z.boolean(),
  available: z.boolean().default(false),
  kind: z.string().min(1).max(64).nullable().optional(),
  source: z.string().min(1).max(64).nullable().optional(),
  plan: z.string().min(1).max(64).nullable().optional(),
  note: z.string().max(512).nullable().optional(),
  effective_remaining_percent: z.number().min(0).max(100).nullable().optional(),
  observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  available_groups: z.array(z.string().min(1).max(128)).max(64).default([]),
  limiting_groups: z.array(z.string().min(1).max(128)).max(64).default([]),
  windows: z.array(QuotaWindowSampleSchema).max(64).default([])
}).strict();

export const MAX_QUOTA_WINDOWS_PER_COLLECTION = 512;

export const QuotaSampleRequestSchema = z.object({
  host: QuotaHostSchema,
  captured_at: z.iso.datetime({ offset: true }),
  schema_version: z.number().int().min(1).max(999),
  app_version: z.string().min(1).max(64).nullable().optional(),
  providers: z.array(QuotaProviderReportSchema).max(32).default([])
}).strict().superRefine((sample, context) => {
  const totalWindows = sample.providers.reduce((count, provider) => count + provider.windows.length, 0);
  if (totalWindows > MAX_QUOTA_WINDOWS_PER_COLLECTION) {
    context.addIssue({
      code: 'custom',
      message: `a collection cannot report more than ${String(MAX_QUOTA_WINDOWS_PER_COLLECTION)} windows in total`
    });
  }
  const seenProviders = new Set<string>();
  for (const provider of sample.providers) {
    if (seenProviders.has(provider.provider)) {
      context.addIssue({ code: 'custom', message: `duplicate provider report in one collection: ${provider.provider}` });
    }
    seenProviders.add(provider.provider);
  }
});

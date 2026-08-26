const MAX_FIELDS = 10;
const MAX_TEXT = 180;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

const SAFE_SCALARS = [
  'ack', 'resulting_status', 'previous_status', 'state', 'status', 'outcome', 'phase',
  'epoch', 'attempt', 'source_attempt', 'delivery_attempt', 'max_attempts', 'output_index',
  'hop_count', 'hop_budget', 'expected', 'completed', 'included_responses',
  'truncated_responses', 'omitted_responses', 'branches', 'branches_dead', 'branches_failed',
  'branches_open', 'open_work', 'idle_seconds', 'age_ms', 'park_max_age_ms', 'body_bytes',
  'reply_characters', 'skipped_delegations', 'skipped_notifications',
  'lease_renewed', 'queued', 'duplicate_replay', 'execution_started', 'attempt_refunded',
  'attempts_exhausted', 'held_for_manual_replay', 'ambiguous_execution',
  'ambiguous_failure_without_execution', 'converged', 'attributed', 'origin_relayed',
  'target_tenant', 'target_alias', 'recipient_tenant', 'recipient_alias', 'asked_by_alias',
  'mode', 'kind', 'source', 'adapter', 'schema', 'trust', 'error_code', 'rejection_code',
  'denial_code', 'claim_provenance', 'parent_notice', 'origin_relay', 'synthesized_by',
  'revision', 'rolled_back_revision', 'desired_revision', 'applied_revision', 'expected_revision',
] as const;

const ARRAY_COUNTS: Readonly<Record<string, string>> = {
  recipients: 'recipient_count',
  cohort: 'cohort_count',
};

function cleanText(value: string, maximum = MAX_TEXT): string {
  const printable = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
  return printable.length <= maximum ? printable : `${printable.slice(0, maximum - 1).trimEnd()}…`;
}

function safeScalar(key: string, value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = cleanText(value, 128);
  return CODE.test(text) ? text : undefined;
}

/**
 * Produce un resumen positivo/allowlisted del JSON de auditoría.
 *
 * Nunca devuelve el objeto original: varios eventos contienen session ids, locators de
 * credenciales, mutaciones completas o texto autorado. El endpoint de consola sólo necesita una
 * frase operacional; los campos no declarados se omiten, no se serializan "por si acaso".
 */
export function safeAuditSummary(action: unknown, metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const source = metadata as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};

  if ((action === 'config.change' || action === 'config.rollback') && typeof source.summary === 'string') {
    const summary = cleanText(source.summary);
    if (summary) result.summary = summary;
  }

  for (const key of SAFE_SCALARS) {
    if (Object.keys(result).length >= MAX_FIELDS) break;
    const value = safeScalar(key, source[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const [sourceKey, countKey] of Object.entries(ARRAY_COUNTS)) {
    if (Object.keys(result).length >= MAX_FIELDS) break;
    const value = source[sourceKey];
    if (Array.isArray(value)) result[countKey] = value.length;
  }

  return Object.keys(result).length === 0 ? null : JSON.stringify(result);
}

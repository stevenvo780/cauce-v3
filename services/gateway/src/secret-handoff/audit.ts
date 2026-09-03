import { createHash } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '@cauce/store';

/**
 * Audit trail of the sealed hand-off plane. Writes straight through the pool for the reason
 * services/gateway/src/terminal/audit.ts documents. Its action union is its own: widening
 * `TerminalAuditAction` would let a terminal query match a credential row.
 *
 * NEVER record a secret or the sealed bytes. Of the ciphertext only its sha256 truncated to 16 hex
 * characters is durable: enough to tie a `secret.read` row to its `secret.granted` row, useless
 * for anything else.
 */

export type SecretAuditAction =
  | 'secret.key_published'
  | 'secret.granted'
  | 'secret.read'
  | 'secret.revoked'
  | 'secret.denied';

export type SecretAuditDecision = 'allow' | 'deny';

export interface SecretAuditEntry {
  readonly tenant_id: string;
  readonly actor_alias: string;
  readonly action: SecretAuditAction;
  readonly decision: SecretAuditDecision;
  readonly trace_id?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Allowlist: the builder copies these keys and nothing else. `label` NAMES the credential. */
export interface SecretAuditFacts {
  readonly label?: string;
  readonly recipient_tenant?: string;
  readonly recipient_alias?: string;
  readonly sealing_key_id?: string;
  readonly sealed_sha256?: string;
  readonly key_id?: string;
  readonly key_fingerprint?: string;
  readonly handoff_id_sha256?: string;
  readonly reason?: string;
  readonly denials_in_window?: number;
}

export function secretAuditMetadata(facts: SecretAuditFacts): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (facts.label !== undefined) metadata.label = facts.label;
  if (facts.recipient_tenant !== undefined) metadata.recipient_tenant = facts.recipient_tenant;
  if (facts.recipient_alias !== undefined) metadata.recipient_alias = facts.recipient_alias;
  if (facts.sealing_key_id !== undefined) metadata.sealing_key_id = facts.sealing_key_id;
  if (facts.sealed_sha256 !== undefined) metadata.sealed_sha256 = facts.sealed_sha256;
  if (facts.key_id !== undefined) metadata.key_id = facts.key_id;
  if (facts.key_fingerprint !== undefined) metadata.key_fingerprint = facts.key_fingerprint;
  if (facts.handoff_id_sha256 !== undefined) metadata.handoff_id_sha256 = facts.handoff_id_sha256;
  if (facts.reason !== undefined) metadata.reason = facts.reason;
  if (facts.denials_in_window !== undefined) {
    metadata.denials_in_window = facts.denials_in_window;
  }
  return metadata;
}

/**
 * Rate limit of the DENIAL rows, and of nothing else. A refusal is written by the very request the
 * flooder controls, so an unthrottled `secret.denied` turns a flood the ceiling already refused
 * into a SECOND unbounded write, into the table the console reads: 4071 rows in 40 s, measured.
 * `audit_events` has no retention sweep for these rows, so what is not bounded here is permanent.
 *
 * A window is opened by the SENDER — tenant, alias and channel of the authenticated principal —
 * and by nothing a request can choose. Keying it on the edge instead let a flooder cycle the
 * recipient NAME and open a fresh window per request: 24046 rows in 20 s against the 16 the same
 * flood writes at a fixed name, measured. A bound the caller can step around is not a bound.
 *
 * A doubling ladder rather than one row per window: a single row per window makes the size of the
 * flood invisible until the window rolls, and the number an auditor needs is the one visible WHILE
 * it happens. The 1st, 2nd, 4th, 8th … refusal of a window is written, each carrying its running
 * count, so four thousand refusals become thirteen rows that already say how big it is getting.
 *
 * One sender's refusals share that count whatever they were refused FOR, so the first refusal of
 * each distinct reason is written as well, up to a cap: a ceiling flood must not be able to bury
 * the one routing refusal underneath it. A sender therefore costs at most a ladder plus a handful
 * of first-of-a-kind rows per window, and the map holds 512 senders — the oldest window goes when
 * it is full, and an evicted sender just opens a new one. The ladder degrades into MORE rows,
 * never into fewer facts: losing a refusal is not a trade this plane makes to save a row.
 */
const DENIAL_WINDOW_MS = 60_000;
const MAX_TRACKED_SENDERS = 512;
const MAX_DENIAL_REASONS_PER_WINDOW = 8;

interface DenialWindow {
  start: number;
  count: number;
  reasons: Set<string>;
}

export interface DenialTally {
  readonly record: boolean;
  readonly count: number;
}

export type DenialThrottle = (sender: string, reason: string, now?: number) => DenialTally;

function evictIfFull(windows: Map<string, DenialWindow>, now: number): void {
  if (windows.size < MAX_TRACKED_SENDERS) return;
  for (const [sender, window] of windows) {
    if (now - window.start >= DENIAL_WINDOW_MS) windows.delete(sender);
  }
  if (windows.size < MAX_TRACKED_SENDERS) return;
  let oldest: string | undefined;
  let oldestStart = Number.POSITIVE_INFINITY;
  for (const [sender, window] of windows) {
    if (window.start < oldestStart) {
      oldestStart = window.start;
      oldest = sender;
    }
  }
  if (oldest !== undefined) windows.delete(oldest);
}

export function createDenialThrottle(): DenialThrottle {
  const windows = new Map<string, DenialWindow>();
  return (sender, reason, now = Date.now()) => {
    const open = windows.get(sender);
    if (open === undefined || now - open.start >= DENIAL_WINDOW_MS) {
      evictIfFull(windows, now);
      windows.set(sender, { start: now, count: 1, reasons: new Set([reason]) });
      return { record: true, count: 1 };
    }
    open.count += 1;
    const firstOfKind = !open.reasons.has(reason)
      && open.reasons.size < MAX_DENIAL_REASONS_PER_WINDOW;
    if (firstOfKind) open.reasons.add(reason);
    return { record: firstOfKind || (open.count & (open.count - 1)) === 0, count: open.count };
  };
}

/** The only durable trace of any byte string this plane handles: sha256 truncated to 16 hex. */
export function shortDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Every row about one hand-off carries this, denials included. Without it a `secret.denied` on the
 * claim path names no hand-off at all and an auditor cannot tell which one was refused; the digest
 * correlates the rows without writing an id that also addresses the claim route.
 */
export function handoffDigest(id: string): string {
  return shortDigest(Buffer.from(id, 'utf8'));
}

export async function recordSecretAudit(
  database: DatabasePool | DatabaseClient, entry: SecretAuditEntry,
): Promise<void> {
  await database.query(
    `INSERT INTO audit_events(tenant_id, actor_alias, action, decision, trace_id, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      entry.tenant_id,
      entry.actor_alias,
      entry.action,
      entry.decision,
      entry.trace_id ?? null,
      JSON.stringify(entry.metadata),
    ],
  );
}

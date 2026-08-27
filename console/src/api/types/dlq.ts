export type DlqTarget = 'delivery' | 'outbox';
export type DlqDisposition =
  | 'ambiguous'
  | 'safe_retry'
  | 'missing_final'
  | 'auth'
  | 'expected_offline'
  | 'unclassified';

/**
 * Safe schema-030 projection.  It intentionally has no payload, error, reason, origin,
 * provider/message/delivery/outbox id or body field: this is the complete browser contract.
 */
export interface DlqItem {
  target?: DlqTarget | null;
  id?: string | null;
  tenantId?: string | null;
  kind?: string | null;
  adapter?: string | null;
  disposition?: DlqDisposition | null;
  open?: boolean | null;
  actionable?: boolean | null;
  evidenceSha256?: string | null;
  attempts?: number | null;
  resolutionRule?: string | null;
  createdAt?: string | null;
  dispositionAt?: string | null;
  resolvedAt?: string | null;
  reopenCount?: number | null;
  lastReopenedAt?: string | null;
}

export interface DlqPage {
  schemaVersion?: number | null;
  items?: DlqItem[] | null;
  total?: number | null;
  truncated?: boolean | null;
  nextCursor?: string | null;
}

export interface ResolveDlqWithoutReplayInput {
  target: DlqTarget;
  id: string;
  evidenceSha256: string;
  reason: string;
  possibleDuplicateAcknowledged: boolean;
  possibleNoDeliveryAcknowledged: boolean;
}

export interface ResolveDlqWithoutReplayResult {
  schemaVersion?: number | null;
  suite?: string | null;
  phase?: 'resolved' | null;
  appliedCount?: number | null;
  alreadyApplied?: boolean | null;
  evidenceSha256?: string | null;
  reasonSha256?: string | null;
  possibleDuplicateAcknowledged?: boolean | null;
  possibleNoDeliveryAcknowledged?: boolean | null;
}

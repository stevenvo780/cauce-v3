import { isDeepStrictEqual } from 'node:util';
import {
  ConfigMutationSchema, esFicheroDelAgente,
  type ConfigMutation, type ProfileRuntimeContract,
} from '@cauce/protocol';
import {
  StoreError, type OperationalDlqResolutionRequest,
} from '@cauce/store';
import type { ProfileRuntimeVerification } from '../../console/agent-profile.routes.js';
import {
  safeCancelReceipt, safeDlqResolution, safeReplayReceipt,
} from '../../facades.js';
import { CONNECTION_TOKEN_PATTERN } from '../shared.js';

const DLQ_ID_PATTERN = CONNECTION_TOKEN_PATTERN;
const DLQ_EVIDENCE_PATTERN = /^[a-f0-9]{64}$/u;
const DLQ_CURSOR_PATTERN = /^(?:[a-f0-9]{2}){1,512}$/u;
const DLQ_RESOLUTION_KEYS = new Set([
  'evidence_sha256',
  'reason',
  'possible_duplicate_acknowledged',
  'possible_no_delivery_acknowledged',
]);
const AUDIT_CURSOR_PATTERN = /^[1-9][0-9]{0,18}$/u;
const AUDIT_QUERY_KEYS = new Set(['limit', 'before']);

export function parseDlqLimit(value: unknown): number {
  if (value === undefined) return 200;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 500) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  return limit;
}

export function parseDlqCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !DLQ_CURSOR_PATTERN.test(value)) {
    throw new StoreError('invalid_input', 'DLQ cursor is invalid');
  }
  return value;
}

export function parseAuditQuery(value: unknown): { limit: number; before: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'audit query must be an object');
  }
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !AUDIT_QUERY_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'audit query contains an unknown field');
  }
  const rawLimit = query.limit;
  if (rawLimit !== undefined && (
    typeof rawLimit !== 'string'
    || !/^[1-9][0-9]{0,2}$/u.test(rawLimit)
    || Number(rawLimit) > 500
  )) {
    throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
  }
  const rawBefore = query.before;
  if (rawBefore !== undefined && (
    typeof rawBefore !== 'string'
    || !AUDIT_CURSOR_PATTERN.test(rawBefore)
    || BigInt(rawBefore) > 9_223_372_036_854_775_807n
  )) {
    throw new StoreError('invalid_input', 'audit cursor is invalid');
  }
  return { limit: rawLimit === undefined ? 100 : Number(rawLimit), before: rawBefore ?? null };
}

export function parseDlqResolution(
  target: unknown,
  id: unknown,
  value: unknown,
): OperationalDlqResolutionRequest {
  if (target !== 'delivery' && target !== 'outbox') {
    throw new StoreError('invalid_input', 'DLQ target is invalid');
  }
  if (typeof id !== 'string' || !DLQ_ID_PATTERN.test(id)) {
    throw new StoreError('invalid_input', 'DLQ incident id is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'DLQ resolution body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== DLQ_RESOLUTION_KEYS.size
      || Object.keys(body).some((key) => !DLQ_RESOLUTION_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'DLQ resolution body has unexpected or missing fields');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1_000
      || [...reason].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })) {
    throw new StoreError('invalid_input', 'DLQ resolution reason is invalid');
  }
  if (typeof body.evidence_sha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(body.evidence_sha256)) {
    throw new StoreError('invalid_input', 'DLQ evidence hash is invalid');
  }
  if (typeof body.possible_duplicate_acknowledged !== 'boolean'
      || typeof body.possible_no_delivery_acknowledged !== 'boolean') {
    throw new StoreError('invalid_input', 'DLQ risk acknowledgements must be booleans');
  }
  return {
    target,
    id,
    evidenceSha256: body.evidence_sha256,
    reason,
    possibleDuplicateAcknowledged: body.possible_duplicate_acknowledged,
    possibleNoDeliveryAcknowledged: body.possible_no_delivery_acknowledged,
  };
}

export function validatedDlqResolutionReceipt(
  value: unknown,
  request: OperationalDlqResolutionRequest,
): Record<string, unknown> {
  const receipt = safeDlqResolution(value);
  const appliedCount = receipt.appliedCount;
  const alreadyApplied = receipt.alreadyApplied;
  const countMatchesReceipt = (appliedCount === 1 && alreadyApplied === false)
    || (appliedCount === 0 && alreadyApplied === true);
  if (receipt.schemaVersion !== 1
      || receipt.suite !== 'cauce-v3-dlq-no-replay-resolution'
      || receipt.phase !== 'resolved'
      || !countMatchesReceipt
      || receipt.evidenceSha256 !== request.evidenceSha256
      || typeof receipt.reasonSha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(receipt.reasonSha256)
      || receipt.possibleDuplicateAcknowledged !== request.possibleDuplicateAcknowledged
      || receipt.possibleNoDeliveryAcknowledged !== request.possibleNoDeliveryAcknowledged) {
    // The transaction may already have committed. Return no false 2xx: an exact retry is safe and
    // the store will answer with its idempotent alreadyApplied receipt.
    throw new StoreError('conflict', 'DLQ resolution did not return an exact durable receipt');
  }
  return receipt;
}

export function validatedReplayReceipt(value: unknown, sourceDeliveryId: string): Record<string, unknown> {
  const receipt = safeReplayReceipt(value);
  if (receipt.delivery_id === null
      || receipt.delivery_id === sourceDeliveryId
      || receipt.replayed_from_delivery_id !== sourceDeliveryId
      || receipt.state !== 'pending'
      || receipt.replayed !== true) {
    throw new StoreError('conflict', 'replay did not return an exact durable receipt');
  }
  return receipt;
}

export function validatedCancelReceipt(value: unknown, deliveryId: string): Record<string, unknown> {
  const receipt = safeCancelReceipt(value);
  if (receipt.delivery_id !== deliveryId
      || receipt.state !== 'dead'
      || receipt.cancelled !== true
      || receipt.cancelled_from_state === null
      || receipt.parent_notice === null
      || typeof receipt.origin_relayed !== 'boolean'
      || receipt.replayable !== true) {
    throw new StoreError('conflict', 'cancel did not return an exact durable receipt');
  }
  return receipt;
}

export function validatedConfigurationReceipt(
  value: unknown,
  dryRun: boolean,
  expectedRolledBackRevisionId: number | null,
  expectedMutation?: ConfigMutation,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  const result = value as Record<string, unknown>;
  const mutation = ConfigMutationSchema.safeParse(result.mutation);
  const inverse = ConfigMutationSchema.safeParse(result.inverse_mutation);
  const revision = result.revision;
  const rolledBackRevisionId = result.rolled_back_revision_id;
  const summary = result.summary;
  const exact = result.applied === !dryRun
    && result.dry_run === dryRun
    && Number.isSafeInteger(revision)
    && Number(revision) >= (dryRun ? 0 : 1)
    && rolledBackRevisionId === expectedRolledBackRevisionId
    && typeof summary === 'string'
    && summary.length >= 1
    && summary.length <= 2_000
    && mutation.success
    && inverse.success
    && (expectedMutation === undefined || isDeepStrictEqual(mutation.data, expectedMutation));
  if (!exact) {
    // The write may have committed before an incompatible layer truncated its receipt. The
    // response reflects no raw fields from the store and forces the client to re-read the revision.
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  return {
    applied: result.applied,
    dry_run: result.dry_run,
    revision,
    rolled_back_revision_id: rolledBackRevisionId,
    summary,
    mutation: mutation.data,
    inverse_mutation: inverse.data,
  };
}

export function runtimeContractFromVerification(
  revision: number,
  verification: ProfileRuntimeVerification,
): ProfileRuntimeContract {
  const documentos = verification.documents.filter((document) => !esFicheroDelAgente(document.name));
  if (verification.state !== 'current' || verification.generation === null
    || documentos.length === 0
    || documentos.some((document) => !document.current
      || document.observed_sha !== document.expected_sha)) {
    throw new Error('runtime profile expectation requires an exact current verification');
  }
  return {
    revision,
    generation: verification.generation,
    documents: documentos.map((document) => ({
      name: document.name,
      path: document.path,
      sha: document.expected_sha,
    })),
  };
}

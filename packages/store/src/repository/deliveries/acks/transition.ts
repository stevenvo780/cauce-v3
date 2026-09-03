import type { Ack, DeliveryState } from '@cauce/protocol';
import { isAmbiguousAckErrorCode } from '@cauce/protocol';
import { hasDeliverableArtifact } from '../../artifact-payload.js';
import { StoreError } from '../../errors.js';
import { textualReply } from '../../outbox.js';
import {
  ackRank, postgresTextSafe, type AckResult, type AgentOutputEntry
} from '../contracts.js';
import type { DeliveryRow } from '../../observability.js';

export interface RepeatedAckRow {
  delivery_id: string;
  status: Ack['status'];
  instance_id: string;
  epoch: string;
  claim_token: string;
  attempt: number;
  applied: boolean;
}

export interface AckTransition {
  nextStatus: DeliveryState;
  nextRank: number;
  terminalAt: 'now()' | 'NULL';
  terminalError: string | undefined;
  terminalErrorCode: string | undefined;
  ambiguousFailure: boolean;
  ambiguousExecution: boolean;
}

export function validateAckRequest(ack: Ack, ackDeadlineMs: number): void {
  if (!ack.claim_token || !ack.attempt) {
    throw new StoreError('fenced', 'ACK requires claim_token and positive attempt');
  }
  if (!Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0) {
    throw new StoreError('conflict', 'ACK deadline must be a positive integer');
  }
}

export function isExactRepeatedAck(
  repeated: RepeatedAckRow,
  deliveryId: string,
  ack: Ack
): boolean {
  return repeated.delivery_id === deliveryId
    && repeated.status === ack.status
    && repeated.instance_id === ack.instance_id
    && Number(repeated.epoch) === ack.epoch
    && repeated.claim_token === ack.claim_token
    && repeated.attempt === ack.attempt;
}

export function deriveAckTransition(
  row: DeliveryRow & { execution_started: boolean },
  ack: Ack,
  outputs: AgentOutputEntry[],
  persistedResult: Record<string, unknown> | undefined
): AckTransition {
  const rank = ackRank(ack.status);
  let nextStatus: DeliveryState = ack.status;
  let nextRank = rank;
  let terminalAt: 'now()' | 'NULL' = rank === 3 ? 'now()' : 'NULL';
  let terminalError = postgresTextSafe(ack.error);
  let terminalErrorCode = postgresTextSafe(ack.error_code);
  const ambiguousFailure = ack.status === 'failed' && isAmbiguousAckErrorCode(ack.error_code);
  const ambiguousExecution = ambiguousFailure && row.execution_started;
  if (ambiguousExecution) {
    nextStatus = 'dead';
    terminalAt = 'now()';
  } else if (ack.status === 'failed' && (ack.retryable || ambiguousFailure)) {
    if (row.attempt < row.max_attempts) {
      nextStatus = 'retry';
      nextRank = 0;
      terminalAt = 'NULL';
    } else {
      nextStatus = 'dead';
      terminalAt = 'now()';
    }
  }
  if (nextStatus === 'done' && row.body.type === 'agent.fanin') {
    if (outputs.length > 0) {
      nextStatus = 'failed';
      terminalError = 'agent.fanin cannot delegate new messages';
      terminalErrorCode = 'FANIN_REDELEGATION_FORBIDDEN';
    } else if (!textualReply(persistedResult) && !hasDeliverableArtifact(persistedResult)) {
      nextStatus = 'failed';
      terminalError = 'agent.fanin requires a non-empty final reply';
      terminalErrorCode = 'MISSING_FINAL_REPLY';
    }
  }
  return {
    nextStatus,
    nextRank,
    terminalAt,
    terminalError,
    terminalErrorCode,
    ambiguousFailure,
    ambiguousExecution
  };
}

export function appliedAckResult(
  deliveryId: string,
  transition: Pick<AckTransition, 'nextStatus'>,
  delegationRejections: NonNullable<AckResult['delegation_rejections']>,
  delegationMaterializations: NonNullable<AckResult['delegation_materializations']>,
  chainGate: { id: string; question: string } | undefined
): AckResult {
  return {
    delivery_id: deliveryId,
    status: transition.nextStatus,
    applied: true,
    receipt: 'applied',
    ...(delegationRejections.length === 0
      ? {}
      : { delegation_rejections: delegationRejections }),
    ...(delegationMaterializations.length === 0
      ? {}
      : { delegation_materializations: delegationMaterializations }),
    ...(chainGate === undefined
      ? {}
      : { chain_gate: { gate_id: chainGate.id, question: chainGate.question } })
  };
}

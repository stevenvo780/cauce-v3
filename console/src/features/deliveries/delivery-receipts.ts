import type { CancelResult, ReplayResult } from '../../api/types';
import { hasExactKeys, isCanonicalUuidV4 } from '../../api/contract-guards';
import { deliveryPolicy } from './delivery-policy';

const PARENT_NOTICE = new Set(['not_child', 'returned', 'denied', 'deferred', 'coalesced']);
const REPLAY_KEYS = ['delivery_id', 'replayed', 'replayed_from_delivery_id', 'state'] as const;
const CANCEL_KEYS = [
  'cancelled', 'cancelled_from_state', 'delivery_id', 'origin_relayed', 'parent_notice',
  'replayable', 'state',
] as const;

/** A successful replay is a new pending delivery explicitly linked to the requested terminal row. */
export function exactReplayReceipt(value: unknown, sourceDeliveryId: string): boolean {
  if (!hasExactKeys(value, REPLAY_KEYS)) return false;
  const result = value as ReplayResult;
  return isCanonicalUuidV4(sourceDeliveryId)
    && result.replayed === true
    && result.replayed_from_delivery_id === sourceDeliveryId
    && result.state === 'pending'
    && isCanonicalUuidV4(result.delivery_id)
    && result.delivery_id !== sourceDeliveryId;
}

/** Cancellation is credited only when every durable side-effect acknowledgement has a type. */
export function exactCancelReceipt(value: unknown, deliveryId: string): boolean {
  if (!hasExactKeys(value, CANCEL_KEYS)) return false;
  const result = value as CancelResult;
  const previous = deliveryPolicy(result.cancelled_from_state);
  return isCanonicalUuidV4(deliveryId)
    && result.cancelled === true
    && result.delivery_id === deliveryId
    && result.state === 'dead'
    && result.replayable === true
    && previous.known
    && previous.cancellable
    && PARENT_NOTICE.has(result.parent_notice ?? '')
    && typeof result.origin_relayed === 'boolean';
}


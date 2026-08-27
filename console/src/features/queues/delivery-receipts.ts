import type { CancelResult, ReplayResult } from '../../api/types';
import { safeDeliveryState } from '../../lib';

const CANCELLABLE = new Set(['pending', 'retry', 'leased', 'accepted', 'started']);
const PARENT_NOTICE = new Set(['not_child', 'returned', 'denied', 'deferred', 'coalesced']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPLAY_KEYS = ['delivery_id', 'replayed', 'replayed_from_delivery_id', 'state'] as const;
const CANCEL_KEYS = [
  'cancelled', 'cancelled_from_state', 'delivery_id', 'origin_relayed', 'parent_notice',
  'replayable', 'state',
] as const;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** A successful replay is a new pending delivery explicitly linked to the requested terminal row. */
export function exactReplayReceipt(value: unknown, sourceDeliveryId: string): boolean {
  if (!exactObjectKeys(value, REPLAY_KEYS)) return false;
  const result = value as ReplayResult;
  return uuid(sourceDeliveryId)
    && result.replayed === true
    && result.replayed_from_delivery_id === sourceDeliveryId
    && result.state === 'pending'
    && uuid(result.delivery_id)
    && result.delivery_id !== sourceDeliveryId;
}

/** Cancellation is credited only when every durable side-effect acknowledgement has a type. */
export function exactCancelReceipt(value: unknown, deliveryId: string): boolean {
  if (!exactObjectKeys(value, CANCEL_KEYS)) return false;
  const result = value as CancelResult;
  const previous = safeDeliveryState(result.cancelled_from_state);
  return uuid(deliveryId)
    && result.cancelled === true
    && result.delivery_id === deliveryId
    && result.state === 'dead'
    && result.replayable === true
    && previous !== undefined
    && CANCELLABLE.has(previous)
    && PARENT_NOTICE.has(result.parent_notice ?? '')
    && typeof result.origin_relayed === 'boolean';
}

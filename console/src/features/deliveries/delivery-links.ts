import { isCanonicalUuidV4 } from '../../api/contract-guards';

/** A delivery is mutated only in Queues; every read-only surface links to this exact row. */
export function queueDeliveryPath(deliveryId: unknown): string | undefined {
  return isCanonicalUuidV4(deliveryId)
    ? `/queues?delivery=${encodeURIComponent(deliveryId)}`
    : undefined;
}

interface DeliveryClaimCoordinates {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
}

interface EventCorrelationCoordinates extends DeliveryClaimCoordinates {
  readonly event_id: string;
}

export function sameDeliveryClaim(
  left: DeliveryClaimCoordinates,
  right: DeliveryClaimCoordinates,
): boolean {
  return left.delivery_id === right.delivery_id
    && left.attempt === right.attempt
    && left.claim_token === right.claim_token;
}

export function sameEventCorrelation(
  left: EventCorrelationCoordinates,
  right: EventCorrelationCoordinates,
): boolean {
  return left.event_id === right.event_id && sameDeliveryClaim(left, right);
}

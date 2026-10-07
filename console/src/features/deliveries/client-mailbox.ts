import type { ClientMailboxDeliveryReceipt, DeliveryView, MessageDetailDelivery } from '../../api/types';
import { deliveryPolicy } from './delivery-policy';

export const MAILBOX_STATE_LABEL = 'Guardado en buzón';
export const MAILBOX_EXPLANATION = 'No acredita lectura ni ejecución';
export const MAILBOX_NOTE = 'Guardado en buzón: almacenamiento durable sin consumidor en línea; no acredita lectura ni ejecución.';

export function isClientMailboxDelivery(
  delivery: unknown,
): delivery is (DeliveryView | MessageDetailDelivery) & { client_mailbox: ClientMailboxDeliveryReceipt } {
  if (delivery === null || typeof delivery !== 'object' || !('client_mailbox' in delivery)) return false;
  const marker: unknown = delivery.client_mailbox;
  return marker !== null && typeof marker === 'object'
    && 'state' in marker && marker.state === 'stored'
    && 'label' in marker && typeof marker.label === 'string'
    && marker.label.trim().length > 0;
}

export function clientMailboxAddress(
  delivery: { recipient_alias?: string | null; alias?: string | null } | null | undefined,
): string | undefined {
  const address = delivery?.recipient_alias ?? delivery?.alias;
  return typeof address === 'string' && address.trim().length > 0 ? address : undefined;
}

export function clientMailboxRecipientLabel(
  delivery: (DeliveryView | MessageDetailDelivery) | null | undefined,
): string {
  if (isClientMailboxDelivery(delivery)) {
    return delivery.client_mailbox.label;
  }
  return clientMailboxAddress(delivery) ?? 'Destino sin dato';
}

export function deliveryReceiptPolicy(
  status: unknown,
  clientMailbox?: ClientMailboxDeliveryReceipt | null,
) {
  if (isClientMailboxDelivery({ client_mailbox: clientMailbox })) {
    return {
      known: true as const,
      state: 'done' as const,
      label: MAILBOX_STATE_LABEL,
      tone: 'done' as const,
      group: 'complete' as const,
      replayable: false,
      cancellable: false,
      errorExpectation: 'absent' as const,
      isMailbox: true,
      explanation: MAILBOX_EXPLANATION,
    };
  }
  return { ...deliveryPolicy(status), isMailbox: false, explanation: undefined };
}

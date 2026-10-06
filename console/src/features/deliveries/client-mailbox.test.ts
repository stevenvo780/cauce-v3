import { describe, expect, it } from 'vitest';
import type { DeliveryView } from '../../api/types';
import {
  clientMailboxAddress,
  clientMailboxRecipientLabel,
  deliveryReceiptPolicy,
  isClientMailboxDelivery,
  MAILBOX_EXPLANATION,
  MAILBOX_STATE_LABEL,
} from './client-mailbox';

describe('client mailbox delivery guard and presentation', () => {
  const mailboxAddress = 'mbx-0123456789abcdef0123456789abcdef';

  it('recognizes a valid client mailbox delivery from API marker', () => {
    const delivery: DeliveryView = {
      delivery_id: '10000000-0000-4000-8000-000000000001',
      recipient_alias: mailboxAddress,
      status: 'done',
      attempt: 0,
      client_mailbox: { label: 'Buzón Cronos', state: 'stored' },
    };
    expect(isClientMailboxDelivery(delivery)).toBe(true);
    expect(clientMailboxAddress(delivery)).toBe(mailboxAddress);
    expect(clientMailboxRecipientLabel(delivery)).toBe('Buzón Cronos');
  });

  it('does NOT infer mailbox identity from address prefix alone without API marker', () => {
    const delivery: DeliveryView = {
      delivery_id: '10000000-0000-4000-8000-000000000002',
      recipient_alias: mailboxAddress,
      status: 'done',
      attempt: 1,
    };
    expect(isClientMailboxDelivery(delivery)).toBe(false);
    expect(clientMailboxAddress(delivery)).toBe(mailboxAddress);
    expect(clientMailboxRecipientLabel(delivery)).toBe(mailboxAddress);
  });

  it('rejects invalid or non-stored mailbox markers', () => {
    expect(isClientMailboxDelivery({
      client_mailbox: { label: 'Buzón', state: 'pending' },
    })).toBe(false);
    expect(isClientMailboxDelivery({
      client_mailbox: { label: '', state: 'stored' },
    })).toBe(false);
    expect(isClientMailboxDelivery({
      client_mailbox: null,
    })).toBe(false);
    expect(isClientMailboxDelivery(undefined)).toBe(false);
    expect(isClientMailboxDelivery(null)).toBe(false);
    expect(isClientMailboxDelivery({ client_mailbox: 'stored' })).toBe(false);
    expect(isClientMailboxDelivery({ client_mailbox: { state: 'stored', label: 42 } })).toBe(false);
    expect(deliveryReceiptPolicy('done', { label: ' ', state: 'stored' }).isMailbox).toBe(false);
  });

  it('provides the stored lifecycle presentation policy without claiming execution', () => {
    const policy = deliveryReceiptPolicy('done', { label: 'Buzón Cronos', state: 'stored' });
    expect(policy.label).toBe(MAILBOX_STATE_LABEL);
    expect(policy.tone).toBe('done');
    expect(policy.isMailbox).toBe(true);
    expect(policy.explanation).toBe(MAILBOX_EXPLANATION);
    expect(policy.label).not.toMatch(/ejecutad/i);
  });
});

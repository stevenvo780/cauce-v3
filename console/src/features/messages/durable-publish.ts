import {
  ApiError, PublishIntentReconciliationError, type CauceApi,
} from '../../api/client';
import type {
  DurablePublishReceipt, PublishIntentSemantics,
} from '../../api/types';
import {
  exactConfirmedPublishIntent, exactPreparedPublishIntent, exactPublishReceipt,
} from './publish-receipt';
import type { ExactPreparePublishIntentResult } from './publish-receipt';
import { randomUuid } from '../../random-id';

type DurablePublishApi = Pick<
  CauceApi,
  'preparePublishIntent' | 'publishMessage' | 'confirmPublishIntent'
>;

export interface DurablePublishOutcome {
  receipt: DurablePublishReceipt;
  reconciled: boolean;
  journalStatus: 'confirmed' | 'pending' | 'rejected';
}

/** Only outcomes whose effect may already have been confirmed admit an immediate exact retry. */
function uncertainPublishOutcome(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.code === 'timeout'
    || cause.status === 408
    || cause.status === 409
    || cause.status === 425
    || cause.status >= 500;
}

/** Confirm does not create the published effect: a 409 here is a definitive rejection, not ambiguity. */
function uncertainConfirmOutcome(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.code === 'timeout'
    || cause.status === 408
    || cause.status === 425
    || cause.status >= 500;
}

function exactReconciliationReceipt(
  cause: unknown,
  expectedDeliveries: number,
  publisherSubject: string | null | undefined,
): DurablePublishReceipt | undefined {
  if (!(cause instanceof PublishIntentReconciliationError)) return undefined;
  const candidate = {
    version: cause.reconciliation.version,
    state: cause.reconciliation.state,
    idempotency_key: cause.reconciliation.idempotency_key,
    receipt: cause.reconciliation.receipt,
  };
  return exactPreparedPublishIntent(candidate, expectedDeliveries, publisherSubject)
    ? candidate.receipt
    : undefined;
}

/**
 * Publishes with an intent prepared in PostgreSQL, never with durable state from the browser.
 *
 * A prepare retry within the same submit reuses the nonce. After reload, the server only
 * reconciles an EFFECT already committed: an empty reservation is not mistaken for a human
 * submission. Confirmation opens the way to deliberately send another identical message.
 */
export async function publishDurably({
  api,
  input,
  publisherSubject,
  expectedDeliveries,
  reconcile,
}: {
  api: DurablePublishApi;
  input: PublishIntentSemantics;
  publisherSubject: string | null | undefined;
  expectedDeliveries: number;
  reconcile: () => void;
}): Promise<DurablePublishOutcome> {
  const intentNonce = randomUuid();
  const prepareInput = { ...input, intent_nonce: intentNonce };
  const prepareExact = async (): Promise<ExactPreparePublishIntentResult> => {
    const candidate = await api.preparePublishIntent(prepareInput);
    if (!exactPreparedPublishIntent(candidate, expectedDeliveries, publisherSubject)) {
      throw new Error('El gateway no devolvió una intención durable exacta; no se publicó nada.');
    }
    return candidate;
  };

  let prepared: ExactPreparePublishIntentResult | undefined;
  let receipt: DurablePublishReceipt | undefined;
  let reconciled = false;
  try {
    prepared = await prepareExact();
  } catch (firstPrepareError) {
    receipt = exactReconciliationReceipt(
      firstPrepareError, expectedDeliveries, publisherSubject,
    );
    if (receipt === undefined) {
      if (!uncertainConfirmOutcome(firstPrepareError)) throw firstPrepareError;
      try {
        prepared = await prepareExact();
      } catch (retryPrepareError) {
        receipt = exactReconciliationReceipt(
          retryPrepareError, expectedDeliveries, publisherSubject,
        );
        if (receipt === undefined) {
          const detail = retryPrepareError instanceof Error
            ? retryPrepareError.message
            : 'el servidor no dijo por qué';
          throw new Error(
            `Resultado incierto al reservar la intención: ${detail}. No se publicó ningún mensaje.`,
          );
        }
      }
    }
  }

  if (receipt !== undefined) {
    reconciled = true;
    reconcile();
  } else if (prepared?.state === 'committed') {
    receipt = prepared.receipt;
    reconciled = true;
    reconcile();
  } else {
    if (prepared?.state !== 'prepared') {
      throw new Error('El gateway no preparó ni reconcilió una intención durable exacta.');
    }
    const command = { ...input, idempotency_key: prepared.idempotency_key };
    const publishExact = async (): Promise<DurablePublishReceipt> => {
      const candidate = await api.publishMessage(command);
      if (!exactPublishReceipt(
        candidate, expectedDeliveries, prepared.idempotency_key, publisherSubject,
      )) {
        throw new Error('el gateway no devolvió un recibo durable exacto');
      }
      return candidate;
    };

    try {
      receipt = await publishExact();
    } catch (firstError) {
      if (!uncertainPublishOutcome(firstError)) throw firstError;
      reconcile();
      try {
        receipt = await publishExact();
        reconciled = true;
      } catch (retryError) {
        reconcile();
        const detail = retryError instanceof Error
          ? retryError.message
          : firstError instanceof Error ? firstError.message : 'el servidor no dijo por qué';
        throw new Error(
          `Resultado incierto: ${detail}. La intención durable quedó en el servidor; `
          + 'al reintentar o recargar se recuperará antes de crear otra publicación.',
        );
      }
    }
  }

  let journalStatus: DurablePublishOutcome['journalStatus'] = 'pending';
  const confirmExact = async (): Promise<void> => {
    const confirmation = await api.confirmPublishIntent({
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    });
    if (!exactConfirmedPublishIntent(confirmation, receipt)) {
      throw new Error('el gateway no confirmó exactamente el journal durable');
    }
  };
  try {
    await confirmExact();
    journalStatus = 'confirmed';
  } catch (firstConfirmError) {
    if (uncertainConfirmOutcome(firstConfirmError)) {
      try {
        await confirmExact();
        journalStatus = 'confirmed';
      } catch (retryError) {
        // Effect has an exact receipt: keep the journal open and fail closed — an identical intent
        // will recover this effect first and cannot duplicate silently.
        journalStatus = uncertainConfirmOutcome(retryError) ? 'pending' : 'rejected';
      }
    } else {
      journalStatus = 'rejected';
    }
  }

  return { receipt, reconciled, journalStatus };
}

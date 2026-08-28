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

type DurablePublishApi = Pick<
  CauceApi,
  'preparePublishIntent' | 'publishMessage' | 'confirmPublishIntent'
>;

export interface DurablePublishOutcome {
  receipt: DurablePublishReceipt;
  reconciled: boolean;
  journalStatus: 'confirmed' | 'pending' | 'rejected';
}

/** Sólo los resultados cuyo efecto puede haberse confirmado admiten un retry exacto inmediato. */
function uncertainPublishOutcome(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.code === 'timeout'
    || cause.status === 408
    || cause.status === 409
    || cause.status === 425
    || cause.status >= 500;
}

/** Confirm no crea el efecto publicado: un 409 acá es un rechazo definitivo, no ambigüedad. */
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
 * Publica con una intención preparada en PostgreSQL, nunca con estado durable del navegador.
 *
 * Un retry de prepare dentro del mismo submit reutiliza el nonce. Tras una recarga, el servidor
 * sólo reconcilia un EFECTO ya committed: una reserva vacía no se confunde con otro envío humano.
 * La confirmación abre la posibilidad de enviar deliberadamente otro mensaje idéntico.
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
  const intentNonce = globalThis.crypto.randomUUID();
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
        // El efecto ya tiene recibo exacto. Mantener el journal abierto falla cerrado: una nueva
        // intención igual primero recuperará este efecto y no podrá duplicarlo en silencio.
        journalStatus = uncertainConfirmOutcome(retryError) ? 'pending' : 'rejected';
      }
    } else {
      journalStatus = 'rejected';
    }
  }

  return { receipt, reconciled, journalStatus };
}

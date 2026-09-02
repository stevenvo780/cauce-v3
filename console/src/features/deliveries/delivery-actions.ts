import type { CancelResult, ReplayResult } from '../../api/types';
import { isCanonicalUuidV4 } from '../../api/contract-guards';
import { compactId } from '../../lib';
import { exactCancelReceipt, exactReplayReceipt } from './delivery-receipts';
import { deliveryPolicy } from './delivery-policy';

export type DeliverySnapshotRefresh =
  | { data: unknown; error?: undefined }
  | { data?: undefined; error: Error };

interface DeliveryMutationApi {
  replayDelivery: (deliveryId: string) => Promise<ReplayResult>;
  cancelDelivery: (deliveryId: string) => Promise<CancelResult>;
}

export type SafeDeliveryActionOutcome =
  | { kind: 'confirmed'; notice: string; rereadCompleted: boolean }
  | {
    kind: 'uncertain';
    notice: string;
    effectProven: boolean;
    reconciliation: DeliveryReconciliation;
  };

export type DeliveryReconciliation =
  | { action: 'replay'; deliveryId: string }
  | { action: 'cancel'; deliveryId: string };

interface SafeDeliveryActionInput {
  api: DeliveryMutationApi;
  deliveryId: string;
  reread: () => Promise<DeliverySnapshotRefresh>;
  /** Called before awaiting the authoritative reread so the caller can lock the row immediately. */
  onUncertain?: (notice: string, reconciliation: DeliveryReconciliation) => void;
}

interface SnapshotRead {
  completed: boolean;
  data?: unknown;
}

async function rereadSnapshot(reread: SafeDeliveryActionInput['reread']): Promise<SnapshotRead> {
  try {
    const refreshed = await reread();
    return refreshed.data === undefined
      ? { completed: false }
      : { completed: true, data: refreshed.data };
  } catch {
    return { completed: false };
  }
}

function records(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) return undefined;
  return items.filter((item): item is Record<string, unknown> => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
  ));
}

/** A snapshot proves an effect only through the durable fields written by that exact command. */
export function rereadProvesDeliveryEffect(
  reconciliation: DeliveryReconciliation,
  snapshot: unknown,
): boolean {
  const items = records(snapshot);
  if (!items || !isCanonicalUuidV4(reconciliation.deliveryId)) return false;

  if (reconciliation.action === 'cancel') {
    const source = items.find((item) => item.delivery_id === reconciliation.deliveryId);
    return source?.state === 'dead'
      && typeof source.last_error === 'string'
      && source.last_error.startsWith('Cancelled by operator ');
  }

  return items.some((item) => (
    isCanonicalUuidV4(item.delivery_id)
    && item.delivery_id !== reconciliation.deliveryId
    && item.replayed_from_delivery_id === reconciliation.deliveryId
    && deliveryPolicy(item.state).known
  ));
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'el servidor no dijo por qué';
}

interface SafeDeliveryCommand {
  run: () => Promise<unknown>;
  exactReceipt: (value: unknown) => boolean;
  missingReceipt: string;
  confirmedNotice: string;
  uncertainHeading: string;
  reconciliation: DeliveryReconciliation;
}

async function runDeliveryCommandSafely(
  { reread, onUncertain }: SafeDeliveryActionInput,
  command: SafeDeliveryCommand,
): Promise<SafeDeliveryActionOutcome> {
  try {
    const result = await command.run();
    if (!command.exactReceipt(result)) throw new Error(command.missingReceipt);
    const snapshot = await rereadSnapshot(reread);
    return {
      kind: 'confirmed',
      notice: command.confirmedNotice,
      rereadCompleted: snapshot.completed,
    };
  } catch (cause) {
    const heading = `${command.uncertainHeading}: ${detail(cause)}.`;
    onUncertain?.(
      `${heading} Se debe releer la cola antes de volver a intentarlo; la acción queda bloqueada durante esa lectura.`,
      command.reconciliation,
    );
    const snapshot = await rereadSnapshot(reread);
    const effectProven = snapshot.completed
      && rereadProvesDeliveryEffect(command.reconciliation, snapshot.data);
    return {
      kind: 'uncertain',
      effectProven,
      reconciliation: command.reconciliation,
      notice: `${heading} ${effectProven
        ? 'La relectura demostró el efecto durable; no se repetirá el POST.'
        : snapshot.completed
          ? 'La cola se releyó, pero el snapshot no demuestra el efecto; la acción permanece bloqueada.'
          : 'No hubo una relectura verificable y la acción permanece bloqueada.'}`,
    };
  }
}

/** Executes one replay command; ambiguity is reconciled by reading, never by posting again. */
export function replayDeliverySafely(input: SafeDeliveryActionInput): Promise<SafeDeliveryActionOutcome> {
  const { api, deliveryId } = input;
  return runDeliveryCommandSafely(input, {
    run: () => api.replayDelivery(deliveryId),
    exactReceipt: (result) => exactReplayReceipt(result, deliveryId),
    missingReceipt: 'el gateway no devolvió un recibo durable exacto del replay',
    confirmedNotice: `Replay encolado para ${compactId(deliveryId)}`,
    uncertainHeading: `Resultado incierto del reinyectado de ${compactId(deliveryId)}`,
    reconciliation: { action: 'replay', deliveryId },
  });
}

/** Executes one cancellation command; ambiguity is reconciled by reading, never by posting again. */
export function cancelDeliverySafely(input: SafeDeliveryActionInput): Promise<SafeDeliveryActionOutcome> {
  const { api, deliveryId } = input;
  return runDeliveryCommandSafely(input, {
    run: () => api.cancelDelivery(deliveryId),
    exactReceipt: (result) => exactCancelReceipt(result, deliveryId),
    missingReceipt: 'el gateway no devolvió un recibo durable exacto de la cancelación',
    confirmedNotice: `Cancelada ${compactId(deliveryId)} (queda en DLQ, se puede replayar)`,
    uncertainHeading: `Resultado incierto de la cancelación de ${compactId(deliveryId)}`,
    reconciliation: { action: 'cancel', deliveryId },
  });
}

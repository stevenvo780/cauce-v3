import { Ban, Clock3, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { ConsoleAccess, DeliveryView } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, permissionState, safeDeliveryState } from '../../lib';

// 'failed' is as replayable as 'dead': both are error finals, and from this patch both leave a row
// in `dead_letters`. Which of the two applied was decided by `ack.retryable`, i.e. the failing agent
// itself, and that has no business deciding whether a human can rescue the work.
const replayableStates: ReadonlySet<string> = new Set(['dead', 'failed']);
const cancellableStates: ReadonlySet<string> = new Set(['pending', 'retry', 'leased', 'accepted', 'started']);

export function AckInspector({ delivery, access, onReplay, onCancel }: {
  delivery?: DeliveryView;
  access?: ConsoleAccess;
  onReplay: (deliveryId: string) => Promise<void>;
  onCancel: (deliveryId: string) => Promise<void>;
}) {
  const [replaying, setReplaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string }>();
  const canReplay = permissionState(access, 'delivery.replay') === 'allowed';
  const canCancel = permissionState(access, 'delivery.cancel') === 'allowed';
  const state = safeDeliveryState(delivery?.status);
  const replayApplies = state !== undefined && replayableStates.has(state);
  const cancelApplies = state !== undefined && cancellableStates.has(state);

  async function replay() {
    if (!delivery?.delivery_id || !canReplay || !replayApplies) return;
    setReplaying(true);
    setNotice(undefined);
    try {
      await onReplay(delivery.delivery_id);
      setNotice({ tone: 'success', text: 'Replay solicitado al control plane.' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Replay falló.' });
    } finally {
      setReplaying(false);
    }
  }

  async function cancel() {
    if (!delivery?.delivery_id || !canCancel || !cancelApplies) return;
    setCancelling(true);
    setNotice(undefined);
    try {
      await onCancel(delivery.delivery_id);
      setNotice({
        tone: 'success',
        text: 'Cancelación aplicada: queda en DLQ (replayable) y el padre y el origen fueron avisados.'
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Cancelación falló.' });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="terminal-inspector-section" aria-labelledby="ack-inspector-title">
      <header className="inspector-title">
        <div><p className="eyebrow">Delivery lifecycle</p><h3 id="ack-inspector-title">ACK timeline</h3></div>
        {delivery ? <Badge tone={state === 'done' ? 'done' : state === 'dead' || state === 'failed' ? 'danger' : state ? 'running' : 'unknown'}><Unknown value={state} /></Badge> : null}
      </header>
      {!delivery ? <EmptyState>Seleccioná una delivery del transcript para inspeccionar sus ACK.</EmptyState> : (
        <>
          <dl className="ack-meta">
            <div><dt>Delivery</dt><dd className="mono">{compactId(delivery.delivery_id)}</dd></div>
            <div><dt>Intento</dt><dd><Unknown value={delivery.attempt} /></dd></div>
          </dl>
          <ol className="ack-timeline">
            {(delivery.timeline ?? []).length ? (delivery.timeline ?? []).map((event, index) => (
              <li key={`${event.status}-${String(event.at ?? index)}`} data-state={event.status}>
                <span className="ack-node" aria-hidden="true" />
                <div>
                  <strong>{event.status.toUpperCase()}</strong>
                  <Time value={event.at} />
                  {event.detail ? <p>{event.detail}</p> : null}
                </div>
                <small>#{event.attempt ?? '—'}</small>
              </li>
            )) : <li className="ack-unknown"><Clock3 size={15} aria-hidden="true" /> Timeline no informada por el servidor.</li>}
          </ol>
          <div className="operator-actions">
            <button
              className="button small"
              type="button"
              disabled={!canReplay || !replayApplies || replaying}
              onClick={() => void replay()}
              title={!canReplay ? 'Requiere delivery.replay' : !replayApplies ? 'Replay solo aplica a deliveries failed o dead' : undefined}
            >
              <RotateCcw size={14} aria-hidden="true" /> {replaying ? 'Solicitando…' : 'Replay'}
            </button>
            <button
              className="button small secondary"
              type="button"
              disabled={!canCancel || !cancelApplies || cancelling}
              onClick={() => void cancel()}
              title={!canCancel ? 'Requiere delivery.cancel' : !cancelApplies ? 'Cancelar solo aplica a deliveries en vuelo' : 'Marca dead, avisa al padre y al origen, y queda replayable'}
            >
              <Ban size={14} aria-hidden="true" /> {cancelling ? 'Cancelando…' : 'Cancelar'}
            </button>
          </div>
          {!canReplay ? <p className="inspector-warning"><ShieldAlert size={14} aria-hidden="true" /> No podés reinyectar: tu cuenta no tiene ese permiso, o no se pudo leer.</p> : null}
          {notice ? <p className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
        </>
      )}
    </section>
  );
}

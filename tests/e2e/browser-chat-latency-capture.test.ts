import { describe, expect, it } from 'vitest';
import { browserDeliveryFailure, ChatLatencyCapture } from './browser-delivery-diagnostics.js';

const message = '00000000-0000-4000-8000-000000000001';
const delivery = '00000000-0000-4000-8000-000000000002';
const operation = '00000000-0000-4000-8000-000000000003';
const foreign = '00000000-0000-4000-8000-000000000004';
const rows = [{ message_id: message, delivery_id: delivery }];
const event = (fields: Record<string, unknown>) => ({ event: 'chat_latency', version: 1, ...fields });
const write = (capture: ChatLatencyCapture, fields: Record<string, unknown>) => { capture.write(`${JSON.stringify(event(fields))}\n`); };

describe('owned browser chat latency capture', () => {
  it('correlates a zero-claim drain by owned delivery and operation without borrowing a foreign delivery', () => {
    const capture = new ChatLatencyCapture();
    const line = `${JSON.stringify(event({ phase: 'drain_started', operation_id: operation, delivery_id: delivery }))}\n`;
    capture.write(line.slice(0, 20));
    capture.write(line.slice(20));
    write(capture, { phase: 'delivery_claim_entered', operation_id: operation, round: 0 });
    write(capture, { phase: 'delivery_claim_result', operation_id: operation, claimed_count: 0, status: 'empty', elapsed_ms: 12.5 });
    write(capture, { phase: 'drain_finished', operation_id: operation });
    write(capture, { phase: 'delivery_claim_result', operation_id: operation, delivery_id: foreign, status: 'returned' });
    write(capture, { phase: 'delivery_claim_result', operation_id: operation, delivery_id: foreign, message_id: message, status: 'returned' });
    write(capture, { phase: 'delivery_claim_result', operation_id: operation, delivery_id: delivery, message_id: foreign, status: 'returned' });
    write(capture, { phase: 'drain_started', operation_id: foreign, delivery_id: foreign });
    expect(capture.forDeliveryRows(rows)).toEqual({ status: 'OBSERVED_PARTIAL_CAPTURE', discarded: 0, events: [
      event({ phase: 'drain_started', operation_id: operation, delivery_id: delivery }),
      event({ phase: 'delivery_claim_entered', operation_id: operation, round: 0 }),
      event({ phase: 'delivery_claim_result', operation_id: operation, elapsed_ms: 12.5, claimed_count: 0, status: 'empty' }),
      event({ phase: 'drain_finished', operation_id: operation }),
    ] });
    expect(capture.forDeliveryRows([])).toEqual({ status: 'OBSERVED_PARTIAL_CAPTURE', discarded: 0, events: [] });
  });

  it('keeps structured timings and rejects secrets, malformed identifiers and unsupported fields', () => {
    const capture = new ChatLatencyCapture();
    write(capture, { phase: 'delivery_claim_result', delivery_id: delivery, message_id: message,
      at: '2026-01-01T00:00:00.000Z', wake_claim_started_at: '2026-01-01T00:00:00.000Z',
      wake_claim_finished_at: 'FakeSECRET', elapsed_ms: 1.25, round: 0, claimed_count: 0,
      attempt: 0, status: 'FakeSECRET', request_id: 'FakeSECRET', error_message: 'FakeSECRET',
      body: 'FakeSECRET', token: 'FakeSECRET', headers: { authorization: 'FakeSECRET' } });
    expect(capture.forDeliveryRows(rows)).toEqual({ status: 'OBSERVED_PARTIAL_CAPTURE', discarded: 0,
      events: [event({ phase: 'delivery_claim_result', delivery_id: delivery, message_id: message,
        at: '2026-01-01T00:00:00.000Z', wake_claim_started_at: '2026-01-01T00:00:00.000Z',
        elapsed_ms: 1.25, round: 0, claimed_count: 0 })] });
    expect(JSON.stringify(capture.forDeliveryRows(rows))).not.toContain('FakeSECRET');
  });

  it('drops raw HTTP logs, invalid phases, versions and non-objects rather than logging their content', () => {
    const capture = new ChatLatencyCapture();
    capture.write('FakeSECRET\nnull\n[]\n');
    capture.write(`${JSON.stringify({ event: 'request', msg: 'FakeSECRET', delivery_id: delivery })}\n`);
    write(capture, { phase: 'FakeSECRET', delivery_id: delivery });
    write(capture, { phase: 'delivery_claim_entered', version: 2, delivery_id: delivery });
    expect(capture.forDeliveryRows(rows)).toEqual({ status: 'OBSERVED_PARTIAL_CAPTURE', discarded: 0, events: [] });
  });

  it('reports bounded capture loss and does not accept out-of-range metrics', () => {
    const capture = new ChatLatencyCapture();
    capture.write('x'.repeat(32_769));
    for (let index = 0; index < 300; index += 1) write(capture, {
      phase: 'drain_finished', delivery_id: delivery, elapsed_ms: Infinity,
      wake_claim_elapsed_ms: -1, round: 16, claimed_count: 1.5,
    });
    const snapshot = capture.forDeliveryRows(rows);
    expect(snapshot.discarded).toBe(45);
    expect(snapshot.events).toHaveLength(256);
    expect(snapshot.events).toEqual(Array.from({ length: 256 }, () => event({ phase: 'drain_finished', delivery_id: delivery })));
  });

  it('preserves the original assertion cause while adding only the correlated gateway observation', async () => {
    const capture = new ChatLatencyCapture();
    write(capture, { phase: 'drain_started', operation_id: operation, delivery_id: delivery });
    write(capture, { phase: 'delivery_claim_result', operation_id: operation, claimed_count: 0, status: 'empty' });
    const cause = new Error('original timeout');
    const error = await browserDeliveryFailure(cause, {
      pool: { query: async ({ text }: { text: string }) => ({ rows: text.includes('d.last_ack_rank') ? rows : [] }) },
      tenant: { tenant: 'Isa', target: 'agentisa', room: 'roomisa' }, instanceId: 'fixture-isa',
      selector: { kind: 'text', value: 'own-test-nonce' }, stdout: '', stderr: '', child: undefined, gateway: capture,
    });
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('"gateway":{"status":"OBSERVED_PARTIAL_CAPTURE"');
    expect(error.message).toContain('"claimed_count":0,"status":"empty"');
    expect(error.message).not.toContain('own-test-nonce');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerTestRequirement } from '../helpers/postgres.js';
import { jsonObject, startChatLatencyFixture } from './web-chat-latency.fixtures.js';

const docker = dockerTestRequirement('web chat latency through HTTPS, PostgreSQL, SDK and deterministic runner');
let fixture: Awaited<ReturnType<typeof startChatLatencyFixture>> | undefined;

beforeAll(async () => { fixture = await startChatLatencyFixture(); console.info('owned_pg_metadata', fixture.resourceMetadata); }, 180_000);
afterAll(async () => { await fixture?.close(); });

function active() {
  if (fixture === undefined) throw new Error('Chat latency fixture is not ready');
  return fixture;
}
function replies(detail: Record<string, unknown>): unknown[] {
  if (!Array.isArray(detail.deliveries)) throw new Error('Message detail omitted deliveries');
  return detail.deliveries.map((item: unknown) => jsonObject(item).reply);
}

async function expectDurableTerminal(messageId: string, expected: string) {
  const current = active();
  const detail = await current.detail(messageId);
  expect(replies(detail)).toContain(expected);
  const state = await current.pool.query<{ status: string; execution_started: boolean }>(
    'SELECT status, execution_started_at IS NOT NULL AS execution_started FROM deliveries WHERE message_id=$1', [messageId]);
  expect(state.rows).toEqual([{ status: 'done', execution_started: true }]);
  return detail;
}

describe('canonical response phases without a provider or browser', () => {
  it('returns a confirmed web receipt before execution and exposes the terminal reply only after the durable ACK', async (context) => {
    await docker.skipIfUnavailable(context.skip);
    const current = active();
    const receipt = await current.publishConsole();
    expect(replies(await current.detail(receipt.message_id))).toEqual([null]);
    const turn = await current.startTurn(receipt.message_id, 'web terminal reply');
    try {
      await turn.runner.entered;
      expect(turn.events.some((event) => event.phase === 'started' && event.execution_started === true)).toBe(true);
      expect(replies(await current.detail(receipt.message_id))).toEqual([null]);
      expect(turn.events.some((event) => event.phase === 'done')).toBe(false);
      turn.runner.finish();
      await turn.completion;
      await expectDurableTerminal(receipt.message_id, 'web terminal reply');
      expect(turn.runner.requests).toHaveLength(1);
      const phases = current.marks.map((mark) => mark.phase);
      expect(phases.indexOf('console-confirmed')).toBeLessThan(phases.indexOf('deterministic-runner-entered'));
      expect(phases.indexOf('ack-started-execution-applied')).toBeLessThan(phases.indexOf('ack-done-applied'));
      expect(current.marks.every((mark, index) => index === 0 || mark.at >= (current.marks[index - 1]?.at ?? Infinity))).toBe(true);
      const relays = await current.pool.query('SELECT id FROM adapter_outbox WHERE delivery_id=$1 AND kind=\'origin_relay\' AND payload->>\'relay_kind\' IS DISTINCT FROM \'ack\'', [turn.delivery.delivery_id]);
      expect(relays.rows).toHaveLength(0);
      console.info('web_phase_marks', JSON.stringify(current.marks));
    } finally { turn.runner.finish(); await turn.completion; }
  }, 30_000);

  it('uses the same terminal ACK for Telegram while creating a separate return relay, rather than equating an activity ACK with a reply', async (context) => {
    await docker.skipIfUnavailable(context.skip);
    const current = active();
    const messageId = await current.publishTelegram();
    const turn = await current.startTurn(messageId, 'telegram terminal reply');
    try {
      await turn.runner.entered;
      expect(replies(await current.detail(messageId))).toEqual([null]);
      turn.runner.finish();
      await turn.completion;
      await expectDurableTerminal(messageId, 'telegram terminal reply');
      const relays = await current.pool.query('SELECT id FROM adapter_outbox WHERE delivery_id=$1 AND kind=\'origin_relay\' AND payload->>\'relay_kind\' IS DISTINCT FROM \'ack\'', [turn.delivery.delivery_id]);
      expect(relays.rows).toHaveLength(1);
      console.info('telegram_phase_marks', JSON.stringify(current.marks));
      expect(turn.runner.requests).toHaveLength(1);
    } finally { turn.runner.finish(); await turn.completion; }
  }, 30_000);
});

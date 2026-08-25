import { describe, expect, it } from 'vitest';
import { collectOutboxMetrics } from '../../deploy/outbox-metrics-core.mjs';

function pool(rows: readonly unknown[][]) {
  let index = 0;
  return {
    async query() {
      const selected = rows[index++] ?? [];
      return { rows: selected, rowCount: selected.length };
    },
  };
}

describe('exact outbox metrics exporter', () => {
  it('publishes exact durable depth, age and open-DLQ gauges', async () => {
    const body = await collectOutboxMetrics(pool([
      [{ kind: 'wake', status: 'pending', value: '2' }],
      [{ kind: 'wake', status: 'pending', value: '4.5' }],
      [{ kind: 'origin_relay', value: '1' }],
    ]));
    expect(body).toContain('cauce_outbox_query_success 1');
    expect(body).toContain('cauce_outbox_depth{kind="wake",status="pending"} 2');
    expect(body).toContain('cauce_outbox_oldest_seconds{kind="wake",status="pending"} 4.5');
    expect(body).toContain('cauce_outbox_dead_letters_open{kind="origin_relay"} 1');
  });

  it.each(['NaN', 'Infinity', '-1'])('fails closed instead of rendering invalid value %s as zero', async (value) => {
    await expect(collectOutboxMetrics(pool([
      [{ kind: 'wake', status: 'pending', value }], [], [],
    ]))).rejects.toThrow('non-finite or negative');
  });

  it('fails closed on an unknown durable kind/status instead of hiding a new queue', async () => {
    await expect(collectOutboxMetrics(pool([
      [{ kind: 'unknown', status: 'pending', value: '1' }], [], [],
    ]))).rejects.toThrow('unknown outbox kind or status');
  });
});

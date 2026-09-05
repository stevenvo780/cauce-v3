import { describe, expect, it } from 'vitest';
import { collectOutboxMetrics } from '../../deploy/runtime/outbox-metrics-core.mjs';

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
      [{ kind: 'origin_relay', disposition: 'ambiguous', actionable: true, value: '1' }],
      [{ kind: 'origin_relay', disposition: 'ambiguous', actionable: true, value: '1' }],
      [{ kind: 'origin_relay', disposition: 'ambiguous', value: '12.5' }],
    ]));
    expect(body).toContain('cauce_outbox_query_success 1');
    expect(body).toContain('cauce_outbox_depth{kind="wake",status="pending"} 2');
    expect(body).toContain('cauce_outbox_oldest_seconds{kind="wake",status="pending"} 4.5');
    expect(body).toContain('cauce_outbox_dead_letters_open{kind="origin_relay"} 1');
    expect(body).toContain('cauce_outbox_dead_letters_open_by_disposition{kind="origin_relay",disposition="ambiguous",actionable="true"} 1');
    expect(body).toContain('cauce_outbox_dead_letters_new{kind="origin_relay",disposition="ambiguous",actionable="true"} 1');
    expect(body).toContain('cauce_outbox_dead_letter_oldest_actionable_seconds{kind="origin_relay",disposition="ambiguous"} 12.5');
  });

  it.each(['NaN', 'Infinity', '-1'])('fails closed instead of rendering invalid value %s as zero', async (value) => {
    await expect(collectOutboxMetrics(pool([
      [{ kind: 'wake', status: 'pending', value }], [], [], [],
      [],
    ]))).rejects.toThrow('non-finite or negative');
  });

  it('fails closed on an unknown durable kind/status instead of hiding a new queue', async () => {
    await expect(collectOutboxMetrics(pool([
      [{ kind: 'unknown', status: 'pending', value: '1' }], [], [], [],
      [],
    ]))).rejects.toThrow('unknown outbox kind or status');
  });

  it('ages only work whose retry or expired lease is eligible now', async () => {
    const queries: string[] = [];
    const recordingPool = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    await collectOutboxMetrics(recordingPool);
    expect(queries[1]).toContain("available_at<=now()");
    expect(queries[1]).toContain("claim_expires_at<=now()");
    expect(queries[1]).not.toMatch(/now\(\)\s*-\s*min\(created_at\)/u);
  });

  it('separates expected-offline and unclassified inventory from actionable incidents, and never pages on reclassification time as new', async () => {
    const queries: string[] = [];
    const body = await collectOutboxMetrics({
      async query(sql: string) {
        queries.push(sql);
        if (queries.length === 3) return { rows: [
          { kind: 'wake', disposition: 'expected_offline', actionable: false, value: '4' },
          { kind: 'wake', disposition: 'unclassified', actionable: false, value: '2' },
        ] };
        return { rows: [] };
      },
    });
    expect(body).toContain('cauce_outbox_dead_letters_open{kind="wake"} 6');
    expect(body).toContain('cauce_outbox_dead_letters_unclassified{kind="wake"} 2');
    expect(body).toContain('cauce_outbox_dead_letters_unclassified{kind="origin_relay"} 0');
    expect(body).toContain('disposition="expected_offline",actionable="false"} 4');
    expect(body).toContain('disposition="unclassified",actionable="false"} 2');
    expect(body).not.toMatch(/dead_letter_oldest_actionable_seconds\{kind="wake",disposition="unclassified"\}/u);
    expect(body).not.toMatch(/dead_letter_oldest_actionable_seconds\{kind="wake",disposition="expected_offline"\}/u);
    expect(queries[3]).toContain("created_at>=now()-interval '10 minutes'");
    expect(queries[3]).not.toContain('disposition_at>=');
  });

  it('keeps unresolved unknown causes visible while separating pending and completed classification', async () => {
    const queries: string[] = [];
    const body = await collectOutboxMetrics({
      async query(sql: string) {
        queries.push(sql);
        if (queries.length === 3) return { rows: [
          { kind: 'origin_relay', disposition: 'unclassified', actionable: false, value: '4' },
        ] };
        if (queries.length === 6) return { rows: [
          { kind: 'origin_relay', classification_state: 'pending_classification', value: '3' },
          { kind: 'origin_relay', classification_state: 'classified_without_cause', value: '1' },
        ] };
        return { rows: [] };
      },
    });
    expect(body).toContain('cauce_outbox_dead_letters_unclassified{kind="origin_relay"} 4');
    expect(body).toContain('cauce_outbox_dead_letters_unclassified_by_state{kind="origin_relay",state="pending_classification"} 3');
    expect(body).toContain('cauce_outbox_dead_letters_unclassified_by_state{kind="origin_relay",state="classified_without_cause"} 1');
    expect(queries[5]).toContain("resolved_at IS NULL AND disposition='unclassified'");
    expect(queries[5]).toContain('disposition_at IS NULL');
  });

  it('matches cauce_dlq_inventory_030/cauce_list_dlq_030: only ambiguous/safe_retry/missing_final/auth are actionable', async () => {
    const queries: string[] = [];
    const body = await collectOutboxMetrics({
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    });
    expect(queries[2]).toContain("(disposition IN ('ambiguous','safe_retry','missing_final','auth')) AS actionable");
    expect(queries[3]).toContain("(disposition IN ('ambiguous','safe_retry','missing_final','auth')) AS actionable");
    expect(queries[4]).toContain("WHERE resolved_at IS NULL AND disposition IN ('ambiguous','safe_retry','missing_final','auth')");
    for (const disposition of ['ambiguous', 'safe_retry', 'missing_final', 'auth']) {
      expect(body).toContain(`kind="wake",disposition="${disposition}",actionable="true"`);
    }
    for (const disposition of ['expected_offline', 'unclassified']) {
      expect(body).toContain(`kind="wake",disposition="${disposition}",actionable="false"`);
    }
  });

  it('fails closed when the database returns a disposition or actionability outside schema 030', async () => {
    await expect(collectOutboxMetrics(pool([
      [], [], [{ kind: 'wake', disposition: 'invented', actionable: true, value: '1' }], [], [],
    ]))).rejects.toThrow('unknown disposition');
    await expect(collectOutboxMetrics(pool([
      [], [], [{ kind: 'wake', disposition: 'expected_offline', actionable: true, value: '1' }], [], [],
    ]))).rejects.toThrow('inconsistent actionable flag');
    await expect(collectOutboxMetrics(pool([
      [], [], [], [], [],
      [{ kind: 'wake', classification_state: 'invented', value: '1' }],
    ]))).rejects.toThrow('unknown classification state');
  });
});

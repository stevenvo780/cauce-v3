import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../../packages/store/src/index.js';
import { ackEnvelope } from '../../packages/store/test/helpers/consumer.js';
import { PasteSessionRunner } from '../../packages/adapter-sdk/src/shared-session/paste-runner.js';
import { codexTranscript } from '../../packages/adapter-sdk/src/shared-session/rollout.js';
import { inputDigest } from '../../packages/adapter-sdk/src/shared-session/consumption.js';
import { FakeTmux } from '../../packages/adapter-sdk/test/shared-session-fake-tmux.js';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });

// The TUI kernel is synthetic; transcript parsing, receipt production and fenced ACKs are real.
export async function ackCanonicalConsumption(
  pool: DatabasePool, directory: string, tenant: 'Isa' | 'Jhon', alias: string, marker: string,
) {
  const repository = new CauceRepository(pool);
  const instance = `canonical-consumer-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instance, [], 60_000, { takeover: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('canonical consumer has no fenced lease');
  }
  const owned = await mkdtemp(join(directory, 'canonical-consumption-'));
  try {
    const deliveries = await repository.claimDeliveries(tenant, alias, instance, lease.epoch,
      10, 30_000, 3, {}, lease.connection_token);
    const delivery = deliveries.find((candidate: DeliveryEnvelope) => candidate.body.text === marker);
    if (delivery === undefined) throw new Error('canonical consumer did not claim this root');
    const input = JSON.stringify(delivery);
    const sid = randomUUID(), turn = randomUUID();
    const sessions = join(owned, 'sessions');
    await mkdir(sessions, { mode: 0o700 });
    const file = join(sessions, `rollout-now-${sid}.jsonl`);
    await appendFile(file, line('session_meta', { id: sid, source: 'cli' }) + '\n', { mode: 0o600 });
    const reply = `respuesta con consumo comprobado ${marker}`;
    const tmux = new FakeTmux();
    tmux.sessionName = `cauce-${alias}`; tmux.paneStartCommand = 'exec codex'; tmux.paneContent = '› ';
    let submitted = false;
    tmux.onSubmit = async text => {
      expect(text).toContain(input);
      expect(text).toContain(marker);
      const correlation = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(text)?.[1];
      if (correlation === undefined) throw new Error('native input has no local correlation nonce');
      const final = JSON.stringify({ reply, messages: [], notify: [], status: 'done',
        retryable: false, artifacts: [], cauce_correlation_id: correlation });
      await appendFile(file, [line('event_msg', { type: 'task_started', turn_id: turn }),
        line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: turn } }),
        line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: final })].join('\n') + '\n');
      submitted = true;
    };
    const runner = new PasteSessionRunner({ alias, harness: 'codex', workspace: '/workspace',
      transcript: codexTranscript(owned), tmux, sleep: () => Promise.resolve(),
      acquireTimeoutMs: 30, turnTimeoutMs: 2_000, injectTimeoutMs: 20, settleMs: 0, pollMs: 1, readyTimeoutMs: 30 });
    const output = await runner.run({ harness: 'codex', command: 'codex', args: [], stdin: input,
      timeoutMs: 2_000, signal: new AbortController().signal });
    expect(submitted).toBe(true);
    expect(output).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
    const witness = output.consumptionWitness;
    expect(witness).toEqual({ version: 1, harness_id: 'codex', native_session_id: sid,
      native_turn_id: turn, input_sha256: inputDigest(input), evidence_kind: 'canonical_final_response' });
    if (witness === undefined) throw new Error('canonical native turn did not prove consumption');
    const ack = ackEnvelope(delivery, { instanceId: instance, epoch: lease.epoch }, {
      output: { reply, messages: [], notify: [], status: 'done', retryable: false, artifacts: [] },
      harness_consumption_v1: witness,
    });
    expect(await repository.ackDelivery(delivery.delivery_id, tenant, alias, ack))
      .toMatchObject({ applied: true, status: 'done' });
    const rows = await pool.query<{ applied: boolean; attempt: number; witness: unknown }>(
      `SELECT applied,attempt,payload->'result'->'harness_consumption_v1' AS witness
         FROM delivery_acks WHERE delivery_id=$1 AND event_id=$2`, [delivery.delivery_id, ack.event_id]);
    expect(rows.rows).toEqual([{ applied: true, attempt: delivery.attempt, witness }]);
    return { reply, witness, deliveryId: delivery.delivery_id };
  } finally {
    try { await repository.releaseLease(tenant, alias, instance, lease.epoch, lease.connection_token); }
    finally { await rm(owned, { recursive: true, force: true }); }
  }
}

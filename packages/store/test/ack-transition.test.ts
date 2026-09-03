import type { Ack } from '@cauce/protocol';
import { describe, expect, it } from 'vitest';
import type { DeliveryRow } from '../src/repository/observability.js';
import {
  appliedAckResult, deriveAckTransition, isExactRepeatedAck, validateAckRequest
} from '../src/repository/deliveries/acks/transition.js';

const row: DeliveryRow & { execution_started: boolean } = {
  id: 'delivery',
  message_id: 'message',
  recipient_tenant: 'Steven',
  recipient_alias: 'socrates',
  status: 'started',
  attempt: 1,
  max_attempts: 3,
  last_ack_rank: 2,
  request_id: 'request',
  trace_id: 'trace',
  tenant_id: 'Steven',
  room_id: 'room',
  actor_alias: 'kant',
  body: { type: 'agent.message' },
  lane: 'batch',
  priority: 0,
  origin: null,
  auth_session_id: null,
  auth_channel: null,
  consumer_instance_id: 'instance',
  consumer_epoch: '2',
  claim_token: 'claim',
  ack_deadline_at: null,
  execution_started: false
};

const ack: Ack = {
  version: '3.0',
  event_id: 'event',
  status: 'failed',
  instance_id: 'instance',
  epoch: 2,
  claim_token: 'claim',
  attempt: 1,
  retryable: true,
  error: 'temporary'
};

describe('ACK transition planning', () => {
  it('rejects requests without both ownership fences or with an invalid deadline', () => {
    expect(() => { validateAckRequest({ ...ack, claim_token: '' }, 30_000); })
      .toThrow('ACK requires claim_token and positive attempt');
    expect(() => { validateAckRequest({ ...ack, attempt: 0 }, 30_000); })
      .toThrow('ACK requires claim_token and positive attempt');
    expect(() => { validateAckRequest(ack, 0); })
      .toThrow('ACK deadline must be a positive integer');
  });

  it('retries a declared retryable failure while attempts remain', () => {
    expect(deriveAckTransition(row, ack, [], undefined)).toMatchObject({
      nextStatus: 'retry', nextRank: 0, terminalAt: 'NULL', ambiguousFailure: false
    });
  });

  it('makes an ambiguous executed result dead without retrying it', () => {
    const transition = deriveAckTransition(
      { ...row, execution_started: true },
      { ...ack, retryable: false, error_code: 'PROCESS_EXIT_AMBIGUOUS' },
      [],
      undefined
    );
    expect(transition).toMatchObject({
      nextStatus: 'dead', terminalAt: 'now()', ambiguousFailure: true,
      ambiguousExecution: true
    });
  });

  it('turns invalid fan-in terminals into exact permanent failures', () => {
    const missingReply = deriveAckTransition(
      { ...row, body: { type: 'agent.fanin' } },
      { ...ack, status: 'done', retryable: false },
      [],
      undefined
    );
    expect(missingReply).toMatchObject({
      nextStatus: 'failed', terminalErrorCode: 'MISSING_FINAL_REPLY'
    });
    const redelegation = deriveAckTransition(
      { ...row, body: { type: 'agent.fanin' } },
      { ...ack, status: 'done', retryable: false },
      [{ index: 0, target: 'kant', body: 'work' }],
      { output: { reply: 'done' } }
    );
    expect(redelegation).toMatchObject({
      nextStatus: 'failed', terminalErrorCode: 'FANIN_REDELEGATION_FORBIDDEN'
    });
  });

  it('requires every repeated event field to match', () => {
    const repeated = {
      delivery_id: row.id,
      status: ack.status,
      instance_id: ack.instance_id,
      epoch: String(ack.epoch),
      claim_token: ack.claim_token,
      attempt: ack.attempt,
      applied: true
    };
    expect(isExactRepeatedAck(repeated, row.id, ack)).toBe(true);
    expect(isExactRepeatedAck({ ...repeated, attempt: 2 }, row.id, ack)).toBe(false);
  });

  it('omits empty optional feedback from the applied receipt', () => {
    expect(appliedAckResult(row.id, { nextStatus: 'done' }, [], [], undefined)).toStrictEqual({
      delivery_id: row.id, status: 'done', applied: true, receipt: 'applied'
    });
  });
});

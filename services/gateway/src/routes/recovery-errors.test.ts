import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { StoreError, type StoreErrorCode, type StoreRecoveryReason } from '@cauce/store';
import { replyError } from './shared.js';

describe('structured store recovery errors over HTTP', () => {
  it.each<{ code: StoreErrorCode; reason: StoreRecoveryReason; status: number }>([
    { code: 'conflict', reason: 'consumer_capacity_missing', status: 409 },
    { code: 'conflict', reason: 'consumer_capacity_invalid', status: 409 },
    { code: 'forbidden', reason: 'consumer_disabled', status: 403 },
    { code: 'conflict', reason: 'idempotency_durable_conflict', status: 409 },
  ])('keeps public code and status while transporting $reason independently of prose', async ({ code, reason, status }) => {
    const app = Fastify();
    app.get('/', (_request, reply) => { replyError(reply, new StoreError(code, 'reworded explanation', reason)); });
    try {
      const response = await app.inject('/');
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: code, message: 'reworded explanation', reason });
    } finally {
      await app.close();
    }
  });

  it('preserves the exact legacy envelope for an untyped conflict', async () => {
    const app = Fastify();
    app.get('/', (_request, reply) => {
      replyError(reply, new StoreError('conflict', 'idempotency key reused with a different request'));
    });
    try {
      const response = await app.inject('/');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'conflict', message: 'idempotency key reused with a different request' });
    } finally {
      await app.close();
    }
  });
});

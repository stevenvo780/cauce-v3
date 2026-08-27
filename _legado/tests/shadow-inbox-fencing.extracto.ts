// Extraído de tests/store-hardening/adversarial-postgres.test.ts (2026-08-27) al mover
// services/shadow-router a _legado. Requiere el harness de store-hardening para correr.
import { expect } from 'vitest';
import { PostgresShadowRepository } from '../services/shadow-router/src/repository.js';
import type { ShadowEnvelope } from '../services/shadow-router/src/types.js';
import type { DatabasePool } from '@cauce/store';

export async function shadowInboxFencingScenario(pool: DatabasePool): Promise<void> {
  const shadow = new PostgresShadowRepository(pool);
  const envelope: ShadowEnvelope = {
    direction: 'v2-to-v3',
    source_event_id: 'shadow-source-1',
    tenant_id: 'Steven',
    correlation: { request_id: 'request-1', trace_id: 'trace-1', conversation_key: 'conversation-1' },
    payload: { text: 'synthetic' },
    expects_human_reply: false,
  };
  await expect(shadow.enqueue(envelope, 'shadow')).resolves.toMatchObject({ duplicate: false });
  await expect(shadow.enqueue(envelope, 'shadow')).resolves.toMatchObject({ duplicate: true });
  const [claim] = await shadow.claim('shadow-a', 1, 10_000);
  expect(claim).toMatchObject({ source_event_id: envelope.source_event_id, attempt: 1 });
  await expect(shadow.health()).resolves.toMatchObject({
    processing: 1, owned_processing: 1, orphaned_processing: 0,
  });

  const replacementShadow = new PostgresShadowRepository(pool);
  await expect(replacementShadow.health()).resolves.toMatchObject({
    processing: 1, owned_processing: 0, orphaned_processing: 1,
  });
  await shadow.releaseUnstartedInbox(claim!, 'test process stopped before route');
  await expect(pool.query<{ status: string; attempts: number }>(
    `SELECT status,attempts FROM shadow_router_inbox WHERE direction=$1 AND source_event_id=$2`,
    [envelope.direction, envelope.source_event_id],
  )).resolves.toMatchObject({ rows: [{ status: 'pending', attempts: 0 }] });
  const [replacementClaim] = await replacementShadow.claim('shadow-b', 1, 10_000);
  expect(replacementClaim).toMatchObject({ attempt: 1 });
  await replacementShadow.completeInbox(replacementClaim!);
  await expect(replacementShadow.claim('shadow-c', 1, 10_000)).resolves.toEqual([]);
}

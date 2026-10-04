import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryEnvelopeSchema } from '@cauce/protocol';
import { sessionFromDelivery } from '../../packages/adapter-sdk/src/sdk/engine/delivery-context.js';
import { startHumanContextFixture, type HumanContextFixture } from './console-human-context-isolation.fixtures.js';

describe('real console human context isolation', () => {
  let fixture: HumanContextFixture | undefined;
  beforeAll(async () => { fixture = await startHumanContextFixture(); }, 180_000);
  afterAll(async () => {
    await fixture?.close();
    if (fixture !== undefined) console.info('own-fixture-cleanup', JSON.stringify({ containerId: fixture.containerId, directory: fixture.directory }));
  }, 60_000);

  function publications() {
    if (fixture === undefined) throw new Error('Fixture did not start');
    return fixture.publications;
  }

  it('preserves a human subject across real logins while separating durable authors', () => {
    const [a, again, b] = publications();
    expect(fixture?.deniedCsrfStatus).toBe(403);
    expect(a.userId).toBe(again.userId);
    expect(a.userId).not.toBe(b.userId);
    expect(a.author).toMatchObject({ kind: 'human' });
    if (typeof a.author !== 'object' || a.author === null || !('subject_id' in a.author)) throw new Error('Missing durable human subject');
    expect(a.author.subject_id).toMatch(/^human:[a-f0-9]{64}$/u);
    if (typeof b.author !== 'object' || b.author === null || !('subject_id' in b.author)) throw new Error('Missing second durable human subject');
    expect(b.author.subject_id).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(a.author.subject_id).not.toBe(b.author.subject_id);
    expect(a.delivery.console_human_subject).toBe(a.author.subject_id);
    expect(b.delivery.console_human_subject).toBe(b.author.subject_id);
    expect(a.delivery).not.toHaveProperty('human_mcp_subject');
    expect(b.delivery).not.toHaveProperty('human_mcp_subject');
    expect(a.author).toEqual(again.author);
    expect(a.author).not.toEqual(b.author);
    expect(a.delivery.authenticated_context?.session_id).not.toBe(again.delivery.authenticated_context?.session_id);
    expect(sessionFromDelivery(a.delivery, 'Isa').sessionKey).toBe(sessionFromDelivery(again.delivery, 'Isa').sessionKey);
  });

  it('keeps two distinct humans out of the same native session despite sharing tenant and alias', () => {
    const [a, , b] = publications();
    const scopeA = sessionFromDelivery(a.delivery, 'Isa');
    const scopeB = sessionFromDelivery(b.delivery, 'Isa');
    expect(scopeA.sessionKey).toMatch(/^auth-v3:/u);
    expect(scopeB.sessionKey).toMatch(/^auth-v3:/u);
    expect(scopeA.sessionKey).not.toBe(scopeB.sessionKey);
  });

  it('isolates absent and ambiguous audited authors per publication without fabricating identity', () => {
    if (fixture === undefined) throw new Error('Fixture did not start');
    expect(fixture.absent).not.toHaveProperty('console_human_subject');
    expect(fixture.ambiguous).not.toHaveProperty('console_human_subject');
    const absent = sessionFromDelivery(fixture.absent, 'Isa');
    const ambiguous = sessionFromDelivery(fixture.ambiguous, 'Isa');
    expect(absent.sessionKey).not.toBe(ambiguous.sessionKey);
    expect(sessionFromDelivery({ ...fixture.absent, attempt: fixture.absent.attempt + 1 }, 'Isa').sessionKey).toBe(absent.sessionKey);
  });

  it('ignores a forged body subject and keeps unnegotiated legacy envelopes unchanged', () => {
    if (fixture === undefined) throw new Error('Fixture did not start');
    const [a] = publications();
    expect(fixture.forged.body.console_human_subject).toBe(`human:${'f'.repeat(64)}`);
    expect(fixture.forged.console_human_subject).toBe(a.delivery.console_human_subject);
    expect(sessionFromDelivery(fixture.forged, 'Isa').sessionKey).toBe(sessionFromDelivery(a.delivery, 'Isa').sessionKey);
    expect(fixture.legacy).not.toHaveProperty('console_human_subject');
    expect(fixture.legacy).not.toHaveProperty('human_mcp_subject');
    expect(DeliveryEnvelopeSchema.omit({ console_human_subject: true }).safeParse(fixture.legacy).success).toBe(true);
  });

  it.each(['human:short', `human:${'A'.repeat(64)}`, `human:${'a'.repeat(64)}\n`])('rejects malformed subject %s at the wire boundary', (subject) => {
    const [a] = publications();
    expect(DeliveryEnvelopeSchema.safeParse({ ...a.delivery, console_human_subject: subject }).success).toBe(false);
  });

  it('accepts only the exact human MCP subject shape at the wire boundary', () => {
    const [a] = publications();
    expect(DeliveryEnvelopeSchema.safeParse({ ...a.delivery, human_mcp_subject: `human:${'a'.repeat(64)}` }).success).toBe(true);
    for (const subject of ['human:short', `human:${'A'.repeat(64)}`, `human:${'a'.repeat(64)}\n`]) {
      expect(DeliveryEnvelopeSchema.safeParse({ ...a.delivery, human_mcp_subject: subject }).success).toBe(false);
    }
  });
});

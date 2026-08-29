import { describe, expect, it } from 'vitest';
import {
  AGENT_PRIORITY_CEILING, AuthenticatedPublishSchema, clampAgentPriority, HUMAN_CHAT_PRIORITY,
  HUMAN_PRIORITY_FLOOR, PublishMessageSchema
} from '../src/index.js';

/**
 * The bands are a contract between four files that never call each other: the Telegram ingress
 * that grants the band, the gateway that refuses to grant it, the store that refuses to copy it,
 * and the claim that reads it. Everything below is the arithmetic those four rely on.
 */
describe('delivery priority bands', () => {
  it('puts the whole human band strictly above everything an agent can reach', () => {
    expect(AGENT_PRIORITY_CEILING).toBeLessThan(HUMAN_PRIORITY_FLOOR);
    expect(HUMAN_CHAT_PRIORITY).toBeGreaterThanOrEqual(HUMAN_PRIORITY_FLOOR);
  });

  it('leaves headroom above the chat entry point for an operator who escalates on purpose', () => {
    expect(HUMAN_CHAT_PRIORITY).toBeLessThan(100);
  });

  it('holds every value an agent could ask for under the ceiling', () => {
    // The four self-assigned values measured in production, plus both wire extremes.
    for (const requested of [100, 90, 85, 60, 51, 1_000]) {
      const applied = clampAgentPriority(requested);
      expect(applied).toBe(AGENT_PRIORITY_CEILING);
    }
  });

  it('never raises a priority, so low-priority background traffic is not promoted by the clamp', () => {
    for (const requested of [-100, -1, 0, 10, 40, AGENT_PRIORITY_CEILING]) {
      expect(clampAgentPriority(requested)).toBe(requested);
    }
  });

  it('answers with the neutral priority for a value that is not a usable number', () => {
    // `messages.priority` is read back from PostgreSQL before being copied onto a child message,
    // so the clamp must survive a row that is not what the column promises.
    expect(clampAgentPriority(Number.NaN)).toBe(0);
    expect(clampAgentPriority(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampAgentPriority(12.9)).toBe(12);
  });

  it('keeps both bands inside the range the wire schemas accept', () => {
    for (const priority of [AGENT_PRIORITY_CEILING, HUMAN_PRIORITY_FLOOR, HUMAN_CHAT_PRIORITY]) {
      expect(AuthenticatedPublishSchema.parse({
        room_id: 'grp.steven',
        recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
        body: { text: 'band' },
        idempotency_key: `band-${priority}`,
        priority
      }).priority).toBe(priority);
    }
  });

  it('keeps the public schema permissive: the ceiling is a routing decision, not a parse error', () => {
    // An adapter asking for 100 must still publish — clamped, never rejected. A 400 here would
    // take the fleet canaries down instead of slowing them down.
    expect(AuthenticatedPublishSchema.parse({
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      body: { text: 'over the ceiling' },
      idempotency_key: 'over-the-ceiling',
      priority: 100
    }).priority).toBe(100);
    expect(PublishMessageSchema.shape.priority.safeParse(100).success).toBe(true);
  });
});

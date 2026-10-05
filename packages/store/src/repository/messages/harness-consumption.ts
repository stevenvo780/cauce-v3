import { HarnessConsumptionEvidenceSchema } from '@cauce/protocol';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function withValidatedConsumptionTimeline(deliveries: unknown): unknown {
  if (!Array.isArray(deliveries)) return deliveries;
  return deliveries.map((delivery: unknown) => {
    if (!record(delivery) || !Array.isArray(delivery.timeline)) return delivery;
    return { ...delivery, timeline: delivery.timeline.map((event: unknown) => {
      if (!record(event) || !Object.hasOwn(event, 'harness_consumption')) return event;
      const parsed = HarnessConsumptionEvidenceSchema.safeParse(event.harness_consumption);
      return { ...event, harness_consumption: parsed.success ? parsed.data : null };
    }) };
  });
}

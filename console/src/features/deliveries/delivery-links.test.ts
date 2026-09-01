import { expect, it } from 'vitest';
import { queueDeliveryPath } from './delivery-links';

it('builds a queue deep link only for a canonical durable delivery id', () => {
  const id = 'a0000000-0000-4000-8000-000000000001';
  expect(queueDeliveryPath(id)).toBe(`/queues?delivery=${id}`);
  expect(queueDeliveryPath(id.toUpperCase())).toBeUndefined();
  expect(queueDeliveryPath('delivery-without-contract')).toBeUndefined();
  expect(queueDeliveryPath(null)).toBeUndefined();
});


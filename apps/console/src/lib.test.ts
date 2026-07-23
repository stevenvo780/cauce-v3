import { permissionState, safeDeliveryState, safeJobState, safeOriginRelayState } from './lib';

it('fails closed for unknown RBAC and runtime states', () => {
  expect(permissionState(undefined, 'job.create')).toBe('unknown');
  expect(permissionState({ permissions: [] }, 'job.create')).toBe('denied');
  expect(permissionState({ permissions: ['job.create'] }, 'job.create')).toBe('allowed');
  expect(safeDeliveryState('invented')).toBeUndefined();
  expect(safeJobState('successful')).toBeUndefined();
  expect(safeOriginRelayState('delivered')).toBeUndefined();
});

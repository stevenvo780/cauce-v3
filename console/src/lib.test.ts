import { permissionState, safeDeliveryState, safeJobLane, safeOriginRelayState } from './lib';

it('fails closed for unknown RBAC and runtime states', () => {
  expect(permissionState(undefined, 'job.create')).toBe('unknown');
  expect(permissionState({ permissions: [] }, 'job.create')).toBe('denied');
  expect(permissionState({ permissions: ['job.create'] }, 'job.create')).toBe('allowed');
  expect(safeDeliveryState('invented')).toBeUndefined();
  // `safeJobState` se retiró con la vista de jobs; `safeJobLane` NO, porque el carril del
  // MENSAJE (no del job) lo siguen leyendo Messages, Queues, Actividad y el cajón de la flota.
  expect(safeJobLane('express')).toBeUndefined();
  expect(safeJobLane('batch')).toBe('batch');
  expect(safeOriginRelayState('delivered')).toBeUndefined();
});

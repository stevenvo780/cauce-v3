import { permissionState, plural, safeJobLane, safeOriginRelayState } from './lib';

it('fails closed for unknown RBAC and runtime states', () => {
  expect(permissionState(undefined, 'job.create')).toBe('unknown');
  expect(permissionState({ permissions: [] }, 'job.create')).toBe('denied');
  expect(permissionState({ permissions: ['job.create'] }, 'job.create')).toBe('allowed');
  // `safeJobState` was retired together with the jobs view; `safeJobLane` was NOT, because the
  // MESSAGE lane (not the job lane) is still read by Messages, Queues, Actividad, and the fleet drawer.
  expect(safeJobLane('express')).toBeUndefined();
  expect(safeJobLane('batch')).toBe('batch');
  expect(safeOriginRelayState('delivered')).toBeUndefined();
});

it('plural elige la palabra en vez de dejar un «(s)» a la vista', () => {
  expect(plural(1, 'bot registrado', 'bots registrados')).toBe('1 bot registrado');
  expect(plural(0, 'bot registrado', 'bots registrados')).toBe('0 bots registrados');
  expect(plural(3, 'texto de rol', 'textos de rol')).toBe('3 textos de rol');
});

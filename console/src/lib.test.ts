import { haceCuanto, permissionState, plural, safeJobLane, safeOriginRelayState } from './lib';

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

const AHORA = Date.parse('2026-08-23T10:00:00.000Z');
const antes = (ms: number) => new Date(AHORA - ms).toISOString();

it('haceCuanto usa la unidad que se lee, y nunca la «m» que sirve para minuto y para mes a la vez', () => {
  expect(haceCuanto(antes(10_000), AHORA)).toBe('hace instantes');
  expect(haceCuanto(antes(4 * 60_000), AHORA)).toBe('hace 4 min');
  expect(haceCuanto(antes(3 * 3_600_000), AHORA)).toBe('hace 3 h');
  expect(haceCuanto(antes(24 * 3_600_000), AHORA)).toBe('ayer');
  expect(haceCuanto(antes(53 * 86_400_000), AHORA)).toBe('hace 53 d');
  expect(haceCuanto(antes(120 * 86_400_000), AHORA)).toBe('hace 4 meses');
  expect(haceCuanto(antes(800 * 86_400_000), AHORA)).toBe('hace 2 años');
  expect(haceCuanto(new Date(AHORA + 2 * 3_600_000).toISOString(), AHORA)).toBe('dentro de 2 h');
});

it('una fecha que no se puede leer NO se convierte en un «hace un rato» inventado', () => {
  expect(haceCuanto(null)).toBeUndefined();
  expect(haceCuanto('')).toBeUndefined();
  expect(haceCuanto('mañana por la tarde')).toBeUndefined();
  expect(haceCuanto(1_700_000_000)).toBeUndefined();
});

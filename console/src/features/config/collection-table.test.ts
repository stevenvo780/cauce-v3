import { nombreMostrado } from './collection-table';

it('la sala sin nombre visible se muestra por su id, no como «sin dato»', () => {
  expect(nombreMostrado('rooms', { id: 'office', display_name: null })).toBe('office');
  expect(nombreMostrado('rooms', { id: 'office', display_name: '  ' })).toBe('office');
  expect(nombreMostrado('rooms', { id: 'office' })).toBe('office');
});

it('el nombre visible manda sobre el id y otras colecciones no caen al id', () => {
  expect(nombreMostrado('rooms', { id: 'office', display_name: 'Oficina' })).toBe('Oficina');
  expect(nombreMostrado('tenants', { id: 'humanizar', display_name: '' })).toBe('humanizar');
  expect(nombreMostrado('memberships', { id: 'x', display_name: '' })).toBeUndefined();
  expect(nombreMostrado('rooms', { display_name: '' })).toBeUndefined();
});

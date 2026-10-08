import { expect, it } from 'vitest';
import { leerDesplazamiento } from './desplazamiento';

it('only the reader leaves the end; a scroll the layout caused while following goes back to it', () => {
  expect(leerDesplazamiento({ abajo: false, pegado: true, delLector: false })).toBe('volver');
  expect(leerDesplazamiento({ abajo: false, pegado: true, delLector: true })).toBe('suelto');
  expect(leerDesplazamiento({ abajo: false, pegado: false, delLector: false })).toBe('suelto');
  expect(leerDesplazamiento({ abajo: true, pegado: false, delLector: false })).toBe('pegado');
});

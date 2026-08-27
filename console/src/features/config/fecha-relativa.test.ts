import { fechaRelativa } from './fecha-relativa';

const AHORA = Date.parse('2026-08-23T10:00:00.000Z');

it('pinta la distancia y CONSERVA la fecha exacta entera', () => {
  const alta = fechaRelativa('2026-07-01T10:00:00.000Z', AHORA);
  expect(alta?.texto).toBe('hace 53 d');
  // Nada se pierde: la fecha exacta sigue disponible para el `title` y para el lector de pantalla.
  expect(alta?.absoluta).toContain('2026');
  expect(alta?.iso).toBe('2026-07-01T10:00:00.000Z');
});

it('usa la unidad que se lee, y nunca la «m» que sirve para minuto y para mes a la vez', () => {
  expect(fechaRelativa(new Date(AHORA - 30_000).toISOString(), AHORA)?.texto).toBe('hace 30 s');
  expect(fechaRelativa(new Date(AHORA - 14 * 60_000).toISOString(), AHORA)?.texto).toBe('hace 14 min');
  expect(fechaRelativa(new Date(AHORA - 3 * 3_600_000).toISOString(), AHORA)?.texto).toBe('hace 3 h');
  expect(fechaRelativa(new Date(AHORA - 24 * 3_600_000).toISOString(), AHORA)?.texto).toBe('ayer');
  // De dos meses para arriba, el narrow de mes («2 m») se confunde con minutos: se pasa a largo.
  expect(fechaRelativa(new Date(AHORA - 120 * 86_400_000).toISOString(), AHORA)?.texto).toBe('hace 4 meses');
  expect(fechaRelativa(new Date(AHORA - 800 * 86_400_000).toISOString(), AHORA)?.texto).toBe('hace 2 años');
});

it('una fecha que no se puede leer NO se convierte en un «hace un rato» inventado', () => {
  expect(fechaRelativa(null)).toBeUndefined();
  expect(fechaRelativa('')).toBeUndefined();
  expect(fechaRelativa('mañana por la tarde')).toBeUndefined();
  expect(fechaRelativa(1_700_000_000)).toBeUndefined();
});

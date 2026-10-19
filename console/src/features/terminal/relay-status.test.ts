import { mensajeDeFalloDeLectura } from './relay-status';

it('el motivo «operator role is required» no se pinta en inglés al invitado lector', () => {
  const texto = mensajeDeFalloDeLectura(new Error('operator role is required'));
  expect(texto).not.toContain('operator role is required');
  expect(texto).toMatch(/operador/);
});

it('un motivo sin traducción conocida se conserva tal cual', () => {
  expect(mensajeDeFalloDeLectura(new Error('la lectura tardó demasiado'))).toBe('la lectura tardó demasiado');
  expect(mensajeDeFalloDeLectura(undefined)).toBe('');
});

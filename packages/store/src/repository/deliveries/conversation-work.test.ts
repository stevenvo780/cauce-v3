import { expect, it } from 'vitest';
import { workExcerpt } from './conversation-work.js';

it.each([
  'password: SYNTHETIC_PASSWORD',
  '{"password":"SYNTHETIC_PASSWORD"}',
  "{'cookie':'SYNTHETIC_COOKIE'}",
  'Contraseña\nSYNTHETIC_PASSWORD',
  'Set-Cookie: SYNTHETIC_COOKIE',
])('withholds credential-bearing historical fragments: %s', (text) => {
  expect(workExcerpt(text, 2048)).toBe('[Contenido omitido: contiene credenciales]');
});

it('preserves ordinary code evidence and bounds Unicode summaries without broken surrogates', () => {
  expect(workExcerpt('server.py SHA abc; py_compile EXIT:0', 2048)).toContain('EXIT:0');
  const text = workExcerpt('😀'.repeat(6000), 2048);
  expect(text.length).toBeLessThanOrEqual(2048);
  expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
});

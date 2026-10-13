import { connect } from 'node:net';
import { afterAll, inject } from 'vitest';
import { TURNO } from './carril-exclusivo.js';

/*
 * Runs before the test file is even imported, so none of its hooks or containers start until
 * the file holds the lane. Registered first, this afterAll runs last: the turn is held until the
 * file's own teardown has finished, and the worker's exit releases it anyway.
 */
const ruta = inject('carrilExclusivo');
if (typeof ruta !== 'string' || ruta === '') {
  throw new Error('carril exclusivo sin servidor: falta tests/helpers/carril-exclusivo.ts en globalSetup');
}
const turno = connect(ruta);
await new Promise<void>((resolve, reject) => {
  let recibido = '';
  const cerrado = (): void => { reject(new Error('el carril exclusivo se cerró antes de dar turno')); };
  turno.once('error', reject);
  turno.once('close', cerrado);
  turno.setEncoding('utf8');
  turno.on('data', (trozo: string) => {
    recibido += trozo;
    if (recibido !== TURNO) return;
    turno.removeListener('close', cerrado);
    turno.removeListener('error', reject);
    turno.on('error', () => undefined);
    resolve();
  });
});

afterAll(() => {
  turno.destroy();
});

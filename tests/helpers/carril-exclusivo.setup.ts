import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
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

/*
 * Under the sharded release gate several vitest processes each have their own lane, so the file also
 * takes one of the gate's host-wide seats: a directory created atomically, holding the owner pid so a
 * seat whose process died is reclaimed. Without CAUCE_CARRIL_EXCLUSIVO_HOST nothing changes.
 */
const anfitrion = process.env.CAUCE_CARRIL_EXCLUSIVO_HOST;
let plaza: string | undefined;
if (anfitrion) {
  const plazas = Number(process.env.CAUCE_CARRIL_EXCLUSIVO_PLAZAS ?? '2');
  if (!Number.isInteger(plazas) || plazas < 1) throw new Error(`CAUCE_CARRIL_EXCLUSIVO_PLAZAS inválido: ${String(process.env.CAUCE_CARRIL_EXCLUSIVO_PLAZAS)}`);
  const vivo = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  for (;;) {
    for (let indice = 0; indice < plazas && plaza === undefined; indice += 1) {
      const candidata = join(anfitrion, `plaza-${String(indice)}`);
      try {
        mkdirSync(candidata);
        writeFileSync(join(candidata, 'pid'), String(process.pid));
        plaza = candidata;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let titular = Number.NaN;
        try { titular = Number(readFileSync(join(candidata, 'pid'), 'utf8')); } catch { /* being written or released */ }
        if (Number.isInteger(titular) && titular > 0 && !vivo(titular)) rmSync(candidata, { recursive: true, force: true });
      }
    }
    if (plaza !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

afterAll(() => {
  if (plaza !== undefined) rmSync(plaza, { recursive: true, force: true });
  turno.destroy();
});

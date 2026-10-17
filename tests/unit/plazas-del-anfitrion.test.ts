import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conPlazaDelGate, nombreDePlaza, plazasDelGate, tomarPlaza } from '../helpers/plazas-del-anfitrion.js';

const ambitoNuevo = (): string => join('/nonexistent-cauce-gate', randomUUID());
const resuelveAntesDe = async (promesa: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([promesa.then(() => true), new Promise<boolean>((listo) => setTimeout(() => { listo(false); }, ms))]);

describe('host-wide gate seats', () => {
  it('holds a waiter until a seat of the scope is released, and scopes never share seats', async () => {
    const ambito = ambitoNuevo();
    const primera = await tomarPlaza(ambito, 2, 20);
    const segunda = await tomarPlaza(ambito, 2, 20);
    const tercera = tomarPlaza(ambito, 2, 20);
    expect(await resuelveAntesDe(tercera, 300)).toBe(false);
    const ajena = await tomarPlaza(ambitoNuevo(), 1, 20);
    await segunda();
    await segunda(); // releasing twice frees one seat, not someone else's
    const soltarTercera = await tercera;
    expect(await resuelveAntesDe(tomarPlaza(ambito, 2, 20), 300)).toBe(false);
    await Promise.all([primera(), soltarTercera(), ajena()]);
  });

  it('frees the seat of a holder that dies without releasing it', async () => {
    const ambito = ambitoNuevo();
    const nombre = JSON.stringify(nombreDePlaza(ambito, 0));
    const titular = spawn(process.execPath, ['-e',
      `require('node:net').createServer().listen(${nombre}, () => { process.stdout.write('tomada\\n'); });`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((listo) => { titular.stdout.once('data', () => { listo(); }); });
    const esperando = tomarPlaza(ambito, 1, 20);
    expect(await resuelveAntesDe(esperando, 300)).toBe(false);
    titular.kill('SIGKILL');
    const soltar = await esperando;
    await soltar();
  });

  it('reads the seats from the gate environment and leaves runs outside a gate unlimited', async () => {
    expect(plazasDelGate('CAUCE_X', 3, {})).toBeUndefined();
    expect(plazasDelGate('CAUCE_X', 3, { CAUCE_X_HOST: '/r' })).toEqual({ ambito: '/r', plazas: 3 });
    expect(plazasDelGate('CAUCE_X', 3, { CAUCE_X_HOST: '/r', CAUCE_X_PLAZAS: '5' })).toEqual({ ambito: '/r', plazas: 5 });
    expect(() => plazasDelGate('CAUCE_X', 3, { CAUCE_X_HOST: '/r', CAUCE_X_PLAZAS: '0' })).toThrow('CAUCE_X_PLAZAS');
    await expect(tomarPlaza('/r', 0)).rejects.toThrow('inválidas');
    expect(await conPlazaDelGate('CAUCE_SIN_GATE_EN_ESTA_PRUEBA', 1, () => Promise.resolve(7))).toBe(7);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertPasswordPolicy, hashPassword, MAX_PASSWORD_LENGTH, parsePasswordHash, verifyPassword
} from './password.js';

const FAST = { cost: 1_024, blockSize: 8, parallelism: 1 };

describe('derivación de contraseñas', () => {
  it('el hash guardado NO contiene la contraseña y cambia con cada alta', async () => {
    const first = await hashPassword('contraseña-de-prueba-larga', FAST);
    const second = await hashPassword('contraseña-de-prueba-larga', FAST);
    expect(first).not.toContain('contraseña-de-prueba-larga');
    // Different salts: two people with the same password do not share a row, and a precomputed
    // rainbow table serves neither of them.
    expect(first).not.toBe(second);
    expect(first.startsWith('$scrypt$n=1024,r=8,p=1$')).toBe(true);
  });

  it('verifica la correcta y rechaza la equivocada', async () => {
    const hash = await hashPassword('la-buena-y-larga', FAST);
    expect(await verifyPassword(hash, 'la-buena-y-larga')).toBe(true);
    expect(await verifyPassword(hash, 'la-buena-y-largo')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
    expect(await verifyPassword(hash, 'x'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });

  it('los parámetros viajan en el hash, así que subirlos no invalida lo guardado', async () => {
    const legacy = await hashPassword('frase-de-paso-vieja', { cost: 512, blockSize: 8, parallelism: 1 });
    expect(parsePasswordHash(legacy).parameters.cost).toBe(512);
    expect(await verifyPassword(legacy, 'frase-de-paso-vieja')).toBe(true);
  });

  it('un hash ilegible devuelve false en vez de lanzar: un throw sería un oráculo', async () => {
    expect(await verifyPassword('contraseña-en-claro', 'contraseña-en-claro')).toBe(false);
    expect(await verifyPassword('$scrypt$n=1024,r=8,p=1$corta$corta', 'lo-que-sea')).toBe(false);
    expect(await verifyPassword('', 'lo-que-sea')).toBe(false);
  });

  it('la política mínima sólo se aplica al alta', () => {
    expect(() => assertPasswordPolicy('corta')).toThrow(/al menos/);
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(/superar/);
    expect(() => assertPasswordPolicy('doce-caracteres-o-mas')).not.toThrow();
  });
});

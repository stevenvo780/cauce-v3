/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from './index.js';

/**
 * `recordQuotaSample` tiene que rechazar un schema_version que esta versión del gateway no
 * entiende ANTES de tocar la base: mapear un formato desconocido a ciegas es exactamente cómo
 * una muestra mal leída dispara la auto-pausa de una suscripción sana. Se prueba con un pool
 * "trampa" que revienta si alguien lo usa (ni .connect() ni .query()), para que el test falle
 * fuerte si el chequeo alguna vez se corre DESPUÉS de empezar la transacción en vez de antes.
 */
function trapPool(): DatabasePool {
  return {
    connect: vi.fn(async () => {
      throw new Error('recordQuotaSample no debería abrir una transacción para un schema_version no soportado');
    }),
    query: vi.fn(async () => {
      throw new Error('recordQuotaSample no debería consultar la base para un schema_version no soportado');
    })
  } as unknown as DatabasePool;
}

function sample(overrides: Partial<QuotaSampleRequest> = {}): QuotaSampleRequest {
  return {
    host: 'kratos',
    captured_at: new Date().toISOString(),
    schema_version: 2,
    providers: [],
    ...overrides
  };
}

describe('CauceRepository.recordQuotaSample -- guarda de schema_version', () => {
  it('rechaza un schema_version fuera de SUPPORTED_QUOTA_SCHEMA_VERSIONS con invalid_input, sin tocar la base', async () => {
    const pool = trapPool();
    const repository = new CauceRepository(pool);
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 999 }))
    ).rejects.toMatchObject({ name: 'StoreError', code: 'invalid_input' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('el error es una instancia real de StoreError (para que statusFor lo mapee a 422)', async () => {
    const repository = new CauceRepository(trapPool());
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 3 }))
    ).rejects.toBeInstanceOf(StoreError);
  });

  it('un schema_version soportado (2) pasa la guarda de versión y sigue de largo hacia la base', async () => {
    const pool = trapPool();
    const repository = new CauceRepository(pool);
    // No nos importa el resultado (la conexión va a fallar a propósito); sólo que la guarda de
    // versión no sea lo que corta la ejecución para un schema_version conocido.
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 2 }))
    ).rejects.not.toMatchObject({ code: 'invalid_input' });
    expect(pool.connect).toHaveBeenCalled();
  });
});

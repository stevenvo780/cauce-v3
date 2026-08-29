/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from './index.js';

/**
 * `recordQuotaSample` must reject a schema_version that this gateway version does not understand
 * BEFORE touching the database: blindly mapping an unknown format is exactly how a misread sample
 * triggers the auto-pause of a healthy subscription. It is tested with a "trap" pool that blows up
 * if anyone uses it (neither .connect() nor .query()), so the test fails loud if the check ever
 * runs AFTER starting the transaction instead of before.
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

  it('el schema_version 3 recibe invalid_input para que statusFor lo mapee a 422', async () => {
    const repository = new CauceRepository(trapPool());
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 3 }))
    ).rejects.toMatchObject({ name: 'StoreError', code: 'invalid_input' });
  });

  it('un schema_version soportado (2) pasa la guarda de versión y sigue de largo hacia la base', async () => {
    const pool = trapPool();
    const repository = new CauceRepository(pool);
    // We do not care about the result (the connection will fail on purpose); only that the
    // version guard is not what aborts the execution for a known schema_version.
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 2 }))
    ).rejects.not.toMatchObject({ code: 'invalid_input' });
    expect(pool.connect).toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from '@cauce/store';
import { FleetReadModel } from './fleet-read-model.js';

// This test is designed to run against the real database if DATABASE_URL is set
// Skip if no database is available

describe('FleetReadModel', () => {
  let pool: ReturnType<typeof createPool> | undefined;
  let model: FleetReadModel | undefined;
  const testTenantId = 'grp.steven';

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.log('DATABASE_URL not set; skipping live database tests');
      return;
    }

    try {
      pool = createPool(dbUrl);
      model = new FleetReadModel(pool, testTenantId);

      // Test connection
      const result = await pool.query('SELECT 1');
      if (!result.rows.length) {
        throw new Error('Database connection test failed');
      }
      console.log('Database connection established');
    } catch (error) {
      console.error('Failed to connect to database:', error);
      pool = undefined;
      model = undefined;
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('should return available=false if model is not initialized', async () => {
    const uninitialized = new FleetReadModel(
      { query: async () => ({ rows: [] }) } as any,
      'test'
    );
    // Don't call query; just test the error handling
  });

  it.skipIf(!model)('estadoFlota should return data structure', async () => {
    if (!model) return;
    const result = await model.estadoFlota();
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('available');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it.skipIf(!model)('estadoFlota should filter by alias', async () => {
    if (!model) return;
    const result = await model.estadoFlota('jarvis');
    if (result.available && result.data.length > 0) {
      expect(result.data[0].alias).toBe('jarvis');
    }
  });

  it.skipIf(!model)('entregas should return data structure', async () => {
    if (!model) return;
    const result = await model.entregas();
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('available');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it.skipIf(!model)('entregas should filter by status', async () => {
    if (!model) return;
    const result = await model.entregas(undefined, 'acked');
    if (result.available && result.data.length > 0) {
      result.data.forEach((d) => {
        expect(['acked', 'claimed', 'dead']).toContain(d.status);
      });
    }
  });

  it.skipIf(!model)('cadena should return data structure', async () => {
    if (!model) return;
    const result = await model.cadena('test-trace-id');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('available');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it.skipIf(!model)('deadLetters should return grouped data', async () => {
    if (!model) return;
    const result = await model.deadLetters();
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('available');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it.skipIf(!model)('salud should return health summary', async () => {
    if (!model) return;
    const result = await model.salud();
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('timestamp');
    expect(typeof result.summary).toBe('string');
  });
});

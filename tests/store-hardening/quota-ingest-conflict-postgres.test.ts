/**
 * Regresión de la ingesta de cuotas (`recordQuotaSample`).
 *
 * `quota_collections` declara `UNIQUE (collector_tenant, host, captured_at)` (migración 013) y el
 * INSERT decía `ON CONFLICT (host,captured_at)`. Postgres no acepta una especificación de
 * ON CONFLICT que no corresponda a un índice único: tira 42P10 y aborta la transacción. O sea que
 * TODO POST /v3/quotas/samples devolvía error, y por eso producción tenía `quota_window_state`
 * vacía y cero muestras en 72 h con el recolector corriendo.
 *
 * Importa para la rotación de cuentas: sin muestras no hay detección de agotamiento, y sin eso el
 * selector no tiene de dónde saber que una suscripción se quedó sin saldo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const CAPTURED_AT = new Date().toISOString();

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM quota_window_state`);
  await pool.query(`DELETE FROM quota_collections`);
});

function sample(overrides: Partial<QuotaSampleRequest> = {}): QuotaSampleRequest {
  return {
    schema_version: 1,
    host: 'kratos',
    captured_at: CAPTURED_AT,
    providers: [{
      provider: 'claude',
      ok: true,
      available: true,
      available_groups: [],
      limiting_groups: [],
      windows: [{
        group_key: 'default',
        window_key: 'session',
        remaining_percent: 63
      }]
    }],
    ...overrides
  };
}

describe('ingesta de cuotas', () => {
  it('acepta una corrida del recolector', async () => {
    const result = await repository.recordQuotaSample('Steven', 'zeus', sample());

    expect(result.duplicate).toBe(false);
    expect(result.accepted_windows).toBe(1);

    // El estado materializado quedó escrito: es lo que lee el selector para detectar agotamiento.
    const state = await pool.query<{ collector_tenant: string }>(
      `SELECT collector_tenant FROM quota_window_state`
    );
    expect(state.rowCount).toBe(1);
    expect(state.rows[0]?.collector_tenant).toBe('Steven');
  });

  it('un reintento del MISMO recolector es idempotente', async () => {
    const first = await repository.recordQuotaSample('Steven', 'zeus', sample());
    const second = await repository.recordQuotaSample('Steven', 'zeus', sample());

    expect(second.duplicate).toBe(true);
    expect(second.collection_id).toBe(first.collection_id);

    const collections = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM quota_collections`);
    expect(collections.rows[0]?.n).toBe(1);
  });

  it('dos tenants con el MISMO nombre de host no comparten fila ni se ven el collection_id', async () => {
    // La clave lleva collector_tenant justamente porque `host` es una cadena que declara el
    // recolector: sin el tenant, el segundo POST sería un "duplicado" del primero y un tenant
    // heredaría la corrida —y el vínculo con las cuentas— del otro.
    const steven = await repository.recordQuotaSample('Steven', 'zeus', sample());
    const miguel = await repository.recordQuotaSample('Miguel', 'kratos', sample());

    expect(miguel.duplicate).toBe(false);
    expect(miguel.collection_id).not.toBe(steven.collection_id);

    const collections = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM quota_collections`);
    expect(collections.rows[0]?.n).toBe(2);
  });
});

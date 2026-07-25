import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';

export interface TestDatabase {
  container: StartedTestContainer;
  pool: DatabasePool;
  url: string;
}

async function waitForDatabase(pool: DatabasePool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
      if (!['ECONNREFUSED', 'ECONNRESET', '57P03', '08006'].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 50)));
    }
  }
  throw lastError;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const password = randomUUID();
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  let builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'cauce_test',
      POSTGRES_USER: 'cauce_test',
      POSTGRES_PASSWORD: password
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ['CMD-SHELL', 'pg_isready -U cauce_test -d cauce_test'],
      interval: 1_000,
      timeout: 3_000,
      retries: 60,
      startPeriod: 1_000
    })
    .withWaitStrategy(Wait.forHealthCheck());
  if (network) builder = builder.withNetworkMode(network);
  const container = await builder.start();
  const host = network ? container.getIpAddress(network) : container.getHost();
  const port = network ? 5432 : container.getMappedPort(5432);
  const url = `postgresql://cauce_test:${encodeURIComponent(password)}@${host}:${port}/cauce_test`;
  const pool = createPool(url);
  try {
    // A healthy container can become visible a few milliseconds before its
    // address is routable on an existing shared Docker network.
    await waitForDatabase(pool);
    await applyMigrations(pool);
    return { container, pool, url };
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }
}

export async function resetTestDatabase(pool: DatabasePool): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await pool.query(`TRUNCATE TABLE
        gateway_oidc_sessions,telegram_egress_effects,channel_bridge_cursors,channel_bridge_leases,
        shadow_compare_verdicts,shadow_human_reply_guards,shadow_router_mappings,shadow_router_inbox,
        egress_notifications,egress_destinations,egress_contacts,
        audit_events,dead_letters,jobs,adapter_outbox,adapter_inbox,delivery_acks,
        deliveries,idempotency_keys,messages,connection_leases
        RESTART IDENTITY CASCADE`);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== '40P01' || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function assertProductionPostgresTls(timeoutMs = 3000) {
  if (process.env.NODE_ENV !== 'production') return;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const parsed = new URL(connectionString);
  const mode = parsed.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '';
  if (mode !== 'verify-full') {
    throw new Error('production PostgreSQL requires sslmode=verify-full');
  }
  const rootCertificate = process.env.PGSSLROOTCERT;
  if (!rootCertificate || !isAbsolute(rootCertificate)) {
    throw new Error('production PostgreSQL requires an absolute PGSSLROOTCERT path');
  }
  let ca;
  try {
    ca = await readFile(rootCertificate, 'utf8');
  } catch (error) {
    throw new Error('production PostgreSQL root certificate is unavailable', { cause: error });
  }
  const require = createRequire(new URL('../packages/store/package.json', import.meta.url));
  const pg = require('pg');
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    ssl: { ca, rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    if (result.rows[0]?.ssl !== true) throw new Error('PostgreSQL connection is not encrypted');
  } finally {
    await client.end().catch(() => undefined);
  }
}

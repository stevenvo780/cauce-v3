import { applyMigrations, createPool } from './db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = createPool(databaseUrl);
try {
  await applyMigrations(pool);
  console.log('Cauce V3 migrations applied');
} finally {
  await pool.end();
}

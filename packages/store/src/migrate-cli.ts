import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, createPool } from './db.js';

// Production schema changes are a stage of deploy-release.sh's authenticated stop/drain/CAS/
// migrate/restore transaction.  Keep the reusable CLI available for explicitly declared dev and
// disposable test DBs, but reject every ambiguous direct entrypoint (including an unset NODE_ENV)
// before reading DATABASE_URL or opening a socket.
// deploy/migrate.mjs is the image's canonical one-shot wrapper and performs the mandatory TLS
// probe before importing this module.
const canonicalProductionEntrypoint = fileURLToPath(
  new URL('../../../deploy/migrate.mjs', import.meta.url),
);
const invokedEntrypoint = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
const directDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
if (invokedEntrypoint !== canonicalProductionEntrypoint && !directDevelopment) {
  throw new Error(
    'direct migration is disabled: use ops/scripts/deploy-release.sh deploy for the ' +
      'stop/drain/migrate/restore transaction; disposable dev/test databases require an exact ' +
      'NODE_ENV=development or NODE_ENV=test with pnpm migrate:dev',
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = createPool(databaseUrl);
try {
  await applyMigrations(pool);
  console.log('Cauce V3 migrations applied');
} finally {
  await pool.end();
}

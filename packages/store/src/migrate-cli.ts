import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, createPool } from './db.js';

// Production schema changes are a stage of deploy/deploy.sh's owner-attended build/pin/migrate/
// up/smoke workflow. Keep the reusable CLI available for explicitly declared dev and
// disposable test DBs, but reject every ambiguous direct entrypoint (including an unset NODE_ENV)
// before reading DATABASE_URL or opening a socket.
// deploy/migrate.mjs is the image's canonical one-shot wrapper and performs the mandatory TLS
// probe before importing this module.
// deploy/Dockerfile flattens deploy/runtime/* into ./deploy/, so both wrapper paths are canonical.
const canonicalProductionEntrypoints = new Set(
  ['../../../deploy/runtime/migrate.mjs', '../../../deploy/migrate.mjs'].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  ),
);
const invokedEntrypoint = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
const directDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
if (!canonicalProductionEntrypoints.has(invokedEntrypoint) && !directDevelopment) {
  throw new Error(
    'direct migration is disabled: use deploy/deploy.sh for the owner-attended ' +
      'build/pin/migrate/up/smoke workflow; disposable dev/test databases require an exact ' +
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

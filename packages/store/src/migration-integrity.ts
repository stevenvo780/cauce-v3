import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const LEGACY_STRUCTURAL_VERSION = '024_agent_role_templates.sql';
const FIRST_ATOMIC_LEDGER_VERSION = '026_agent_profile.sql';
/**
 * Canonical structural fingerprint of a clean PostgreSQL 16 database after applying the
 * checked-in migrations from 001 through 024, inclusive.  The integration test builds that
 * database from scratch and proves both the matching and drift cases; this value is not learned
 * from an already-migrated database and is never backfilled from production.
 */
export const expectedLegacy024SchemaSha256 =
  '2fb915fd9455da0a30929ab61e835a915de774e9a397163205f065c2221f42c5';

const FINGERPRINT_024_SQL = `
SELECT jsonb_build_object(
  'columns', (SELECT jsonb_agg(jsonb_build_array(
      relation.relname, attribute.attname, format_type(attribute.atttypid,attribute.atttypmod),
      attribute.attnotnull, pg_get_expr(default_value.adbin,default_value.adrelid)
    ) ORDER BY relation.relname,attribute.attnum)
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid=relation.oid AND default_value.adnum=attribute.attnum
    WHERE namespace.nspname='public'
      AND relation.relname IN ('agent_role_templates','agent_role_brief_history','agents')
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND (relation.relname<>'agents' OR attribute.attname='role_template_slug')),
  'constraints', (SELECT jsonb_agg(jsonb_build_array(
      relation.relname,constraint_value.conname,constraint_value.contype,
      constraint_value.convalidated,pg_get_constraintdef(constraint_value.oid,true)
    ) ORDER BY relation.relname,constraint_value.conname)
    FROM pg_constraint constraint_value
    JOIN pg_class relation ON relation.oid=constraint_value.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public'
      AND (relation.relname IN ('agent_role_templates','agent_role_brief_history')
        OR constraint_value.conname='agents_role_template_fk')),
  'indexes', (SELECT jsonb_agg(jsonb_build_array(
      relation.relname,index_relation.relname,pg_get_indexdef(index_relation.oid)
    ) ORDER BY relation.relname,index_relation.relname)
    FROM pg_class index_relation
    JOIN pg_index index_value ON index_value.indexrelid=index_relation.oid
    JOIN pg_class relation ON relation.oid=index_value.indrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public'
      AND index_relation.relname IN ('agents_role_template_idx','agent_role_brief_history_alias_idx')),
  'functions', (SELECT jsonb_agg(jsonb_build_array(
      procedure.proname,pg_get_function_identity_arguments(procedure.oid),
      pg_get_function_result(procedure.oid),language.lanname,procedure.provolatile,
      procedure.proparallel,
      regexp_replace(btrim(procedure.prosrc),'[[:space:]]+',' ','g')
    ) ORDER BY procedure.proname)
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
    JOIN pg_language language ON language.oid=procedure.prolang
    WHERE namespace.nspname='public'
      AND procedure.proname IN ('cauce_agents_role_template_coherence','cauce_agents_role_brief_journal')),
  'triggers', (SELECT jsonb_agg(jsonb_build_array(
      relation.relname,trigger_value.tgname,trigger_value.tgenabled,
      pg_get_triggerdef(trigger_value.oid,true)
    ) ORDER BY relation.relname,trigger_value.tgname)
    FROM pg_trigger trigger_value
    JOIN pg_class relation ON relation.oid=trigger_value.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND NOT trigger_value.tgisinternal
      AND trigger_value.tgname IN ('agents_role_template_coherence','agents_role_brief_journal'))
) AS fingerprint`;

export interface MigrationIntegrityEntry {
  version: string;
  sourceSha256: string;
  applied: boolean;
  sourceOrigin: 'applied-atomically' | 'undetermined' | 'pending';
  verificationMethod: 'atomic-ledger-v1' | 'structural-equivalence-v1' | 'legacy-name-only' | 'not-applied';
  observedSchemaSha256?: string;
}

export interface MigrationIntegrityReport {
  schemaVersion: 1;
  structuralContract: '024-agent-role-templates-v1';
  entries: MigrationIntegrityEntry[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sourceEntries(): Promise<{ version: string; source: string; sourceSha256: string }[]> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const versions = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(versions.map(async (version) => {
    const source = await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8');
    return { version, source, sourceSha256: sha256(source) };
  }));
}

async function relationExists(client: pg.PoolClient, relation: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${relation}`],
  );
  return result.rows[0]?.present === true;
}

async function observed024Fingerprint(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{ fingerprint: unknown }>(FINGERPRINT_024_SQL);
  const fingerprint = result.rows[0]?.fingerprint;
  const observed = sha256(JSON.stringify(fingerprint));
  if (observed !== expectedLegacy024SchemaSha256) {
    throw new Error(
      `${LEGACY_STRUCTURAL_VERSION} structural fingerprint mismatch ` +
      `(expected ${expectedLegacy024SchemaSha256}, observed ${observed})`,
    );
  }
  return observed;
}

export async function ensureMigrationIntegrityTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration_ledger (
    version text PRIMARY KEY REFERENCES schema_migrations(version) ON DELETE CASCADE,
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    source_origin text NOT NULL CHECK (source_origin='applied-atomically'),
    recorded_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration_verifications (
    version text NOT NULL REFERENCES schema_migrations(version) ON DELETE CASCADE,
    bundled_source_sha256 text NOT NULL CHECK (bundled_source_sha256 ~ '^[a-f0-9]{64}$'),
    observed_schema_sha256 text NOT NULL CHECK (observed_schema_sha256 ~ '^[a-f0-9]{64}$'),
    verification_method text NOT NULL CHECK (verification_method='structural-equivalence-v1'),
    source_origin text NOT NULL CHECK (source_origin='undetermined'),
    verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version,bundled_source_sha256,observed_schema_sha256)
  )`);
}

export async function inspectMigrationIntegrity(client: pg.PoolClient): Promise<MigrationIntegrityReport> {
  const sources = await sourceEntries();
  if (!await relationExists(client, 'schema_migrations')) {
    throw new Error('schema_migrations is absent');
  }
  const appliedResult = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.version));
  const sourceVersions = new Set(sources.map((source) => source.version));
  const unknownApplied = [...applied].filter((version) => !sourceVersions.has(version)).sort();
  if (unknownApplied.length > 0) {
    throw new Error(`applied migrations are absent from the release image: ${unknownApplied.join(', ')}`);
  }
  const ledger = new Map<string, string>();
  if (await relationExists(client, 'schema_migration_ledger')) {
    const ledgerResult = await client.query<{ version: string; source_sha256: string; source_origin: string }>(
      `SELECT ledger.version,ledger.source_sha256,ledger.source_origin
         FROM schema_migration_ledger ledger
         LEFT JOIN schema_migrations migration ON migration.version=ledger.version
        WHERE migration.version IS NOT NULL
        ORDER BY ledger.version`,
    );
    for (const row of ledgerResult.rows) {
      if (row.source_origin !== 'applied-atomically') {
        throw new Error(`${row.version} atomic ledger has invalid source origin`);
      }
      ledger.set(row.version, row.source_sha256);
    }
  }

  const entries: MigrationIntegrityEntry[] = [];
  for (const source of sources) {
    if (!applied.has(source.version)) {
      entries.push({
        version: source.version,
        sourceSha256: source.sourceSha256,
        applied: false,
        sourceOrigin: 'pending',
        verificationMethod: 'not-applied',
      });
      continue;
    }
    const ledgerHash = ledger.get(source.version);
    if (ledgerHash !== undefined) {
      if (ledgerHash !== source.sourceSha256) {
        throw new Error(`${source.version} source hash differs from its atomic ledger`);
      }
      entries.push({
        version: source.version,
        sourceSha256: source.sourceSha256,
        applied: true,
        sourceOrigin: 'applied-atomically',
        verificationMethod: 'atomic-ledger-v1',
        ...(source.version === LEGACY_STRUCTURAL_VERSION
          ? { observedSchemaSha256: await observed024Fingerprint(client) }
          : {}),
      });
      continue;
    }
    if (source.version === LEGACY_STRUCTURAL_VERSION) {
      entries.push({
        version: source.version,
        sourceSha256: source.sourceSha256,
        applied: true,
        sourceOrigin: 'undetermined',
        verificationMethod: 'structural-equivalence-v1',
        observedSchemaSha256: await observed024Fingerprint(client),
      });
      continue;
    }
    if (source.version >= FIRST_ATOMIC_LEDGER_VERSION) {
      throw new Error(`${source.version} is applied without an atomic source ledger`);
    }
    entries.push({
      version: source.version,
      sourceSha256: source.sourceSha256,
      applied: true,
      sourceOrigin: 'undetermined',
      verificationMethod: 'legacy-name-only',
    });
  }
  return { schemaVersion: 1, structuralContract: '024-agent-role-templates-v1', entries };
}

export async function migrationSourcesForApply(): Promise<
{ version: string; source: string; sourceSha256: string }[]
> {
  return sourceEntries();
}

export async function recordLegacy024Verification(
  client: pg.PoolClient,
  sourceSha256: string,
): Promise<void> {
  const observed = await observed024Fingerprint(client);
  await client.query(
    `INSERT INTO schema_migration_verifications(
       version,bundled_source_sha256,observed_schema_sha256,verification_method,source_origin
     ) VALUES ($1,$2,$3,'structural-equivalence-v1','undetermined')
     ON CONFLICT DO NOTHING`,
    [LEGACY_STRUCTURAL_VERSION, sourceSha256, observed],
  );
}

export const migrationIntegrityVersions = {
  legacyStructural: LEGACY_STRUCTURAL_VERSION,
  firstAtomicLedger: FIRST_ATOMIC_LEDGER_VERSION,
} as const;

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOfficialJevUrl, DEFAULT_JEV_URL } from './jev-client.js';

export interface ServiceConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly healthPort: number;
  readonly tlsCertFile: string;
  readonly tlsKeyFile: string;
  readonly clientCaFile: string;
  readonly identitiesFile: string;
  /** Aliases that may ask, or `*`; empty = nobody. */
  readonly allowedAliases: ReadonlySet<string>;
  /** Tenants whose agents may spend the Jev key, named one by one; empty = nobody. */
  readonly allowedTenants: ReadonlySet<string>;
  readonly enabledTemplates: ReadonlySet<string>;
  readonly catalogDir: string;
  readonly redact: boolean;
  readonly jev: {
    readonly url: string;
    readonly keyFile: string;
    readonly model: string;
    readonly totalTimeoutMs: number;
    readonly attemptTimeoutMs: number;
    readonly maxRounds: number;
    readonly hedgeAfterMs: number;
  };
  readonly limits: {
    readonly perMinute: number;
    readonly burst: number;
    readonly dailyInputTokens: number;
    readonly dailyInputTokensTotal: number;
    readonly concurrency: number;
    readonly concurrencyPerAlias: number;
  };
}

export const DEFAULT_KEY_FILE = '/etc/cauce-v3/secrets/typesafe-jev.key';
const PREFIX = 'CAUCE_DECISIONES_';

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[PREFIX + name];
  if (value === undefined || value.length === 0) throw new Error(`falta ${PREFIX}${name}`);
  return value;
}

function databaseUrl(env: Env): string {
  const direct = env[`${PREFIX}DATABASE_URL`]?.trim();
  const file = env[`${PREFIX}DATABASE_URL_FILE`]?.trim();
  if (direct && file) throw new Error(`${PREFIX}DATABASE_URL y DATABASE_URL_FILE son excluyentes`);
  let value = direct;
  if (file) {
    if (!isAbsolute(file)) throw new Error(`${PREFIX}DATABASE_URL_FILE debe ser una ruta absoluta`);
    try { value = readFileSync(file, 'utf8').trim(); }
    catch { throw new Error('el secreto de conexión PostgreSQL no está disponible'); }
  }
  if (!value) throw new Error(`falta ${PREFIX}DATABASE_URL o DATABASE_URL_FILE`);
  let protocol: string;
  try { protocol = new URL(value).protocol; }
  catch { throw new Error('la conexión PostgreSQL no es una URL válida'); }
  if (!['postgres:', 'postgresql:'].includes(protocol)) throw new Error('la conexión PostgreSQL debe usar postgres o postgresql');
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[PREFIX + name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${PREFIX}${name} debe ser un entero entre ${String(min)} y ${String(max)}`);
  return value;
}

function list(env: Env, name: string): Set<string> | undefined {
  const raw = env[PREFIX + name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return new Set(raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0));
}

function tenants(env: Env): Set<string> {
  const allowed = list(env, 'TENANTS') ?? new Set<string>();
  if (allowed.has('*')) throw new Error(`${PREFIX}TENANTS no admite '*': nombrá cada tenant`);
  return allowed;
}

function enabledTemplates(env: Env): Set<string> {
  const enabled = list(env, 'HABILITAR_PLANTILLAS') ?? new Set<string>();
  for (const key of enabled) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}\/[a-z][a-z0-9_]{1,63}$/u.test(key)) {
      throw new Error(`${PREFIX}HABILITAR_PLANTILLAS requiere empresa/id`);
    }
  }
  return enabled;
}

export function loadConfig(env: Env = process.env): ServiceConfig {
  const production = env.NODE_ENV === 'production';
  const url = env[`${PREFIX}JEV_URL`] ?? DEFAULT_JEV_URL;
  if (production) assertOfficialJevUrl(url);
  const totalTimeoutMs = integer(env, 'TIMEOUT_MS', 30_000, 1_000, 120_000);
  return {
    databaseUrl: databaseUrl(env),
    host: env[`${PREFIX}HOST`] ?? '0.0.0.0',
    port: integer(env, 'PORT', 8447, 1, 65_535),
    healthPort: integer(env, 'HEALTH_PORT', 8088, 1, 65_535),
    tlsCertFile: required(env, 'TLS_CERT_FILE'),
    tlsKeyFile: required(env, 'TLS_KEY_FILE'),
    clientCaFile: required(env, 'CLIENT_CA_FILE'),
    identitiesFile: required(env, 'IDENTITY_FILE'),
    allowedAliases: list(env, 'ALIASES') ?? new Set(),
    allowedTenants: tenants(env),
    enabledTemplates: enabledTemplates(env),
    catalogDir: env[`${PREFIX}CATALOGO_DIR`] ?? fileURLToPath(new URL('../catalogo/', import.meta.url)),
    redact: env[`${PREFIX}REDACTAR`] !== '0',
    jev: {
      url,
      keyFile: env[`${PREFIX}JEV_KEY_FILE`] ?? DEFAULT_KEY_FILE,
      model: env[`${PREFIX}JEV_MODEL`] ?? 'jev-latest',
      totalTimeoutMs,
      attemptTimeoutMs: integer(env, 'INTENTO_TIMEOUT_MS', 15_000, 500, totalTimeoutMs),
      maxRounds: integer(env, 'RONDAS', 3, 1, 6),
      hedgeAfterMs: integer(env, 'HEDGE_MS', 3_000, 0, totalTimeoutMs),
    },
    limits: {
      perMinute: integer(env, 'POR_MINUTO', 60, 1, 6_000),
      burst: integer(env, 'RAFAGA', 20, 1, 1_000),
      dailyInputTokens: integer(env, 'TOKENS_DIA', 2_000_000, 1_000, 1_000_000_000),
      dailyInputTokensTotal: integer(env, 'TOKENS_DIA_TOTAL', 20_000_000, 1_000, 10_000_000_000),
      concurrency: integer(env, 'CONCURRENCIA', 16, 1, 256),
      concurrencyPerAlias: integer(env, 'CONCURRENCIA_ALIAS', 4, 1, 256),
    },
  };
}

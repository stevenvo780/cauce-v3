import { fileURLToPath } from 'node:url';
import { assertOfficialJevUrl, DEFAULT_JEV_URL } from './jev-client.js';

export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly healthPort: number;
  readonly tlsCertFile: string;
  readonly tlsKeyFile: string;
  readonly clientCaFile: string;
  readonly identitiesFile: string;
  readonly allowedAliases: ReadonlySet<string> | undefined;
  readonly enabledTemplates: ReadonlySet<string>;
  readonly catalogDir: string;
  readonly auditFile: string;
  readonly auditMaxBytes: number;
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
    readonly concurrency: number;
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

export function loadConfig(env: Env = process.env): ServiceConfig {
  const production = env.NODE_ENV === 'production';
  const url = env[`${PREFIX}JEV_URL`] ?? DEFAULT_JEV_URL;
  if (production) assertOfficialJevUrl(url);
  const totalTimeoutMs = integer(env, 'TIMEOUT_MS', 30_000, 1_000, 120_000);
  return {
    host: env[`${PREFIX}HOST`] ?? '0.0.0.0',
    port: integer(env, 'PORT', 8447, 1, 65_535),
    healthPort: integer(env, 'HEALTH_PORT', 8088, 1, 65_535),
    tlsCertFile: required(env, 'TLS_CERT_FILE'),
    tlsKeyFile: required(env, 'TLS_KEY_FILE'),
    clientCaFile: required(env, 'CLIENT_CA_FILE'),
    identitiesFile: required(env, 'IDENTITY_FILE'),
    allowedAliases: list(env, 'ALIASES'),
    enabledTemplates: list(env, 'HABILITAR_PLANTILLAS') ?? new Set(),
    catalogDir: env[`${PREFIX}CATALOGO_DIR`] ?? fileURLToPath(new URL('../catalogo/', import.meta.url)),
    auditFile: env[`${PREFIX}AUDIT_FILE`] ?? '/var/lib/cauce-decisiones/auditoria.jsonl',
    auditMaxBytes: integer(env, 'AUDIT_MAX_BYTES', 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
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
      concurrency: integer(env, 'CONCURRENCIA', 16, 1, 256),
    },
  };
}

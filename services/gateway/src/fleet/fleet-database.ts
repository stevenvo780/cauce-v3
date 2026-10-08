import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import pg from 'pg';
import { createPool, type DatabasePool } from '@cauce/store';

const invalid = () => new Error('Fleet authentication database TLS configuration is invalid');
const dnsLabel = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u;
export function createFleetAuthDatabasePool(connectionString: string, environment: NodeJS.ProcessEnv = process.env): DatabasePool {
  const servername = environment.CAUCE_FLEET_DATABASE_TLS_SERVERNAME;
  if (servername === undefined) return createPool(connectionString, { applicationName: 'cauce-fleet-auth', max: 4 });
  let url: URL;
  try { url = new URL(connectionString); } catch { throw invalid(); }
  const certificate = environment.PGSSLROOTCERT;
  if (environment.NODE_ENV !== 'production' || servername.length > 253 || isIP(servername) !== 0
      || !servername.split('.').every(label => dnsLabel.test(label)) || !['postgres:', 'postgresql:'].includes(url.protocol)
      || isIP(url.hostname) !== 4 || !url.hostname.startsWith('127.') || url.searchParams.has('host')
      || url.searchParams.getAll('sslmode').length > 1 || (url.searchParams.get('sslmode') ?? environment.PGSSLMODE) !== 'verify-full'
      || !certificate || !isAbsolute(certificate) || normalize(certificate) !== certificate || /[\p{Cc}]/u.test(certificate)) throw invalid();
  let ca: string;
  try { ca = readFileSync(certificate, 'utf8'); } catch { throw invalid(); }
  // pg-connection-string rebuilds ssl from these URL keys before each new client.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) url.searchParams.delete(key);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000,
    application_name: 'cauce-fleet-auth', ssl: { ca, servername, rejectUnauthorized: true } });
  pool.on('error', () => undefined);
  return pool;
}

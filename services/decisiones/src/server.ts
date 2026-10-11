import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHealthServer } from '@cauce/protocol';
import { createPool } from '@cauce/store';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { JsonlAudit, PostgresAudit, type AuditSink } from './audit.js';
import { loadCatalog } from './catalog.js';
import type { ServiceConfig } from './config.js';
import { DecisionService } from './decide.js';
import { durableCompanyResolver, mtlsIdentity, type ResolveCompany } from './identity.js';
import { JevClient } from './jev-client.js';
import { Limits } from './limits.js';

export interface RunningService {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly health: Server;
  close(): Promise<void>;
}

export interface ServiceDependencies {
  readonly resolveCompany: ResolveCompany;
  readonly audit?: AuditSink;
}

/** Wires the pieces and listens with mandatory client certificates signed by the Cauce CA. */
export async function startService(
  config: ServiceConfig, fetchImpl?: typeof fetch, dependencies?: ServiceDependencies,
): Promise<RunningService> {
  const [cert, key, ca, catalog] = await Promise.all([
    readFile(config.tlsCertFile),
    readFile(config.tlsKeyFile),
    readFile(config.clientCaFile),
    loadCatalog(config.catalogDir),
  ]);
  const jev = new JevClient({
    ...config.jev,
    backoffBaseMs: 500,
    backoffMaxMs: 5_000,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const pool = dependencies === undefined
    ? createPool(config.databaseUrl, { max: 4, applicationName: 'cauce-decisiones' }) : undefined;
  const resolveCompany = dependencies?.resolveCompany ?? (pool === undefined
    ? (() => { throw new Error('decision company resolver is unavailable'); }) : durableCompanyResolver(pool));
  const durableAudit = dependencies?.audit ?? (pool === undefined ? undefined : new PostgresAudit(pool));
  const jsonl = new JsonlAudit(config.auditFile, config.auditMaxBytes);
  const service = new DecisionService({
    catalog,
    jev,
    limits: new Limits(config.limits),
    audit: { write: async (record) => {
      await durableAudit?.write(record);
      await jsonl.write(record);
    } },
    redact: config.redact,
    enabledTemplates: config.enabledTemplates,
  });
  const app = buildApp({
    service,
    identify: mtlsIdentity({
      identitiesFile: config.identitiesFile,
      allowedAliases: config.allowedAliases,
      allowedTenants: config.allowedTenants,
      resolveCompany,
    }),
    credentialPresent: () => jev.credentialPresent(),
    jevModel: config.jev.model,
    fastify: { https: { cert, key, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' } },
  });
  if (pool !== undefined) app.addHook('onClose', async () => { await pool.end(); });
  try {
    if (pool !== undefined) await pool.query('SELECT id FROM companies LIMIT 1');
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const port = (app.server.address() as AddressInfo).port;
  const health = startHealthServer({
    port: config.healthPort,
    host: '127.0.0.1',
    live: () => ({ ok: true, body: { status: 'live' } }),
    ready: async () => {
      const credential = await jev.credentialPresent();
      const database = pool === undefined || await pool.query('SELECT 1').then(() => true, () => false);
      const ready = app.server.listening && database;
      return { ok: ready, body: { status: ready ? 'ready' : 'starting', plantillas_comunes: catalog.plantillas.size, credencial_jev: credential } };
    },
  });
  return {
    app,
    port,
    health,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => { health.close(() => { resolve(); }); });
    },
  };
}

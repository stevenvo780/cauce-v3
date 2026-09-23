import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHealthServer } from '@cauce/protocol';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { JsonlAudit } from './audit.js';
import { loadCatalog } from './catalog.js';
import type { ServiceConfig } from './config.js';
import { DecisionService } from './decide.js';
import { mtlsIdentity } from './identity.js';
import { JevClient } from './jev-client.js';
import { Limits } from './limits.js';

export interface RunningService {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly health: Server;
  close(): Promise<void>;
}

/** Wires the pieces and listens with mandatory client certificates signed by the Cauce CA. */
export async function startService(config: ServiceConfig, fetchImpl?: typeof fetch): Promise<RunningService> {
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
  const service = new DecisionService({
    catalog,
    jev,
    limits: new Limits(config.limits),
    audit: new JsonlAudit(config.auditFile, config.auditMaxBytes),
    redact: config.redact,
    enabledTemplates: config.enabledTemplates,
  });
  const app = buildApp({
    service,
    identify: mtlsIdentity({
      identitiesFile: config.identitiesFile,
      allowedAliases: config.allowedAliases,
      allowedTenants: config.allowedTenants,
    }),
    credentialPresent: () => jev.credentialPresent(),
    jevModel: config.jev.model,
    fastify: { https: { cert, key, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' } },
  });
  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as AddressInfo).port;
  const health = startHealthServer({
    port: config.healthPort,
    host: '127.0.0.1',
    live: () => ({ ok: true, body: { status: 'live' } }),
    ready: async () => {
      const credential = await jev.credentialPresent();
      return { ok: app.server.listening, body: { status: app.server.listening ? 'ready' : 'starting', plantillas: catalog.plantillas.size, credencial_jev: credential } };
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

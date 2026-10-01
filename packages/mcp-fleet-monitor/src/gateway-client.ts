import { readFile } from 'node:fs/promises';
import { request, type RequestOptions } from 'node:https';
import { TenantSchema } from '@cauce/protocol';
import { httpsOrigin, validBearer, type GatewayConfiguration } from './gateway-configuration.js';
import { GatewayReadError, projectGatewayAgents, projectGatewayStatus } from './gateway-projection.js';

export const GATEWAY_TIMEOUT_MS = 5000;
export const MAX_GATEWAY_BYTES = 256 * 1024;
const ROUTES = { status: '/v3/status', agents: '/v3/console/agents' } as const;

async function tlsOptions(config: GatewayConfiguration): Promise<RequestOptions> {
  try {
    return {
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      ...(config.caFile ? { ca: await readFile(config.caFile) } : {}),
      ...(config.certificateFile ? { cert: await readFile(config.certificateFile) } : {}),
      ...(config.keyFile ? { key: await readFile(config.keyFile) } : {}),
    };
  } catch {
    throw new Error('Gateway TLS files could not be loaded');
  }
}

export async function createGatewayReader(config: GatewayConfiguration) {
  const origin = httpsOrigin(config.origin);
  const tenant = TenantSchema.parse(config.tenant);
  const bearerToken = config.bearerToken;
  if ((bearerToken !== undefined && !validBearer(bearerToken))
    || Boolean(config.certificateFile) !== Boolean(config.keyFile)
    || (!bearerToken && !config.certificateFile)) throw new Error('Gateway authentication is invalid');
  const tls = await tlsOptions(config);

  function read(route: keyof typeof ROUTES): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        fail(new GatewayReadError('gateway_timeout'));
      }, GATEWAY_TIMEOUT_MS);
      const fail = (error: GatewayReadError) => { clearTimeout(timeout); reject(error); };
      const req = request(new URL(ROUTES[route], origin), {
        ...tls, method: 'GET', signal: controller.signal,
        headers: {
          accept: 'application/json', 'accept-encoding': 'identity',
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
      }, (response) => {
        const status = response.statusCode;
        if (status !== 200) {
          response.destroy();
          fail(new GatewayReadError(status === 401 ? 'gateway_unauthorized'
            : status === 403 ? 'gateway_forbidden' : 'gateway_unavailable'));
          return;
        }
        if (response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
          || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          fail(new GatewayReadError('gateway_response_invalid'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_GATEWAY_BYTES) {
            response.destroy();
            fail(new GatewayReadError('gateway_response_too_large'));
          } else chunks.push(chunk);
        });
        response.on('error', () => { fail(new GatewayReadError(controller.signal.aborted ? 'gateway_timeout' : 'gateway_unavailable')); });
        response.on('end', () => {
          clearTimeout(timeout);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
          catch { fail(new GatewayReadError('gateway_response_invalid')); }
        });
      });
      req.on('error', () => { fail(new GatewayReadError(controller.signal.aborted ? 'gateway_timeout' : 'gateway_unavailable')); });
      req.on('upgrade', (_response, socket) => {
        socket.destroy();
        fail(new GatewayReadError('gateway_unavailable'));
      });
      req.end();
    });
  }

  return {
    status: async () => projectGatewayStatus(await read('status'), tenant),
    agents: async () => projectGatewayAgents(await read('agents'), tenant),
  };
}

export type GatewayReader = Awaited<ReturnType<typeof createGatewayReader>>;

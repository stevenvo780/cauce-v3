import type { FastifyRequest } from 'fastify';
import { routedPath } from './http-auth-primitives.js';

const sensitive = new Set(['state', 'code', 'code_verifier', 'code_challenge', 'request_id', 'csrf', 'client_id', 'redirect_uri',
  'access_token', 'refresh_token', 'id_token', 'client_secret', 'device_code', 'user_code']);

function redactDevicePath(path: string): string {
  return path.replace(/(\/v3\/auth\/device\/)(?!approve(?:[/?\s]|$)|token(?:[/?\s]|$))[^/?\s]+/gu, '$1[redacted]');
}

function redactQuery(path: string, query: string): boolean {
  const params = new URLSearchParams(query);
  return routedPath(path).startsWith('/oauth/') || [...sensitive].some(key => params.has(key));
}

export function oauthLogMessage(value: string): string {
  return redactDevicePath(value.replace(/(\/[^\s?]*)\?([^\s]*)/gu,
    (match: string, path: string, query: string) => redactQuery(path, query) ? path : match));
}

export function oauthRequestLog(request: FastifyRequest) {
  const [path = '', query = ''] = request.url.split('?', 2);
  const params = new URLSearchParams(query);
  const redact = redactQuery(path, query);
  return {
    method: request.method,
    url: redactDevicePath(redact ? path : request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    ...(request.raw.socket.remotePort === undefined ? {} : { remotePort: request.raw.socket.remotePort }),
    ...(redact ? { oauthParameters: [...sensitive].filter(key => params.has(key)) } : {}),
  };
}

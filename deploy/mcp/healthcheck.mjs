import { request } from 'node:http';

const timeout = AbortSignal.timeout(2500);

function fail() {
  process.exitCode = 1;
}

function requestMetadata(port, host) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port,
      path: '/.well-known/oauth-protected-resource/mcp',
      method: 'GET',
      headers: { host, accept: 'application/json' },
      signal: timeout,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.byteLength;
        if (size > 4096) req.destroy(new Error('metadata too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        contentType: response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase(),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  const originValue = process.env.CAUCE_MCP_PUBLIC_ORIGIN;
  const issuer = process.env.CAUCE_MCP_OAUTH_ISSUER;
  const portValue = process.env.CAUCE_MCP_PORT ?? '3101';
  const port = Number(portValue);
  const origin = new URL(originValue);
  const parsedIssuer = new URL(issuer);
  if (process.env.CAUCE_MCP_AUTH_MODE !== 'oauth'
    || origin.protocol !== 'https:' || ![origin.origin, `${origin.origin}/`].includes(originValue)
    || parsedIssuer.protocol !== 'https:'
    || ![parsedIssuer.href, parsedIssuer.href.replace(/\/$/, '')].includes(issuer)
    || !/^[0-9]+$/.test(portValue) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    fail();
  } else {
    const response = await requestMetadata(port, origin.host);
    let metadata;
    try {
      metadata = JSON.parse(response.body);
    } catch {
      metadata = undefined;
    }
    if (response.status !== 200 || response.contentType !== 'application/json'
      || metadata?.resource !== `${origin.origin}/mcp`
      || !Array.isArray(metadata?.authorization_servers)
      || metadata.authorization_servers.length !== 1
      || metadata.authorization_servers[0] !== issuer) fail();
  }
} catch {
  fail();
}

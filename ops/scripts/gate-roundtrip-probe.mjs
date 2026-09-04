#!/usr/bin/env node
/** Publishes a single gate delivery over mTLS and leaves only ephemeral 0600 correlation. */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundedInteger } from './bounded-environment-integer.mjs';

const [alias, outputFile] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.length !== 4 || !alias || !outputFile) {
  console.error('usage: gate-roundtrip-probe.mjs ALIAS EVIDENCE.json');
  process.exit(2);
}
if (!/^[a-z][a-z0-9-]*$/.test(alias)) {
  console.error('invalid alias format');
  process.exit(2);
}

async function regularFile(file, label, privateFile = false) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${label} path must be absolute`);
  const metadata = await lstat(file).catch(() => undefined);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  if (privateFile && (metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group/world accessible`);
  if (privateFile && typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the probe user`);
  }
  return readFile(file);
}

async function targetFromInventory() {
  const inventoryFile = process.env.CAUCE_GATE_INVENTORY_FILE ?? path.resolve(here, '..', 'container-aliases.json');
  const raw = await regularFile(inventoryFile, 'gate inventory');
  let decoded;
  try { decoded = JSON.parse(raw.toString('utf8')); } catch { throw new Error('gate inventory is not valid JSON'); }
  const entry = decoded?.aliases?.[alias];
  if (!entry || typeof entry.tenant !== 'string') {
    throw new Error('alias is not declared in the gate inventory');
  }
  return { tenant: entry.tenant, sourceRoom: 'grp.steven', alias };
}

function gatewayUrl() {
  const raw = process.env.CAUCE_GATE_PROBE_URL;
  if (!raw) throw new Error('CAUCE_GATE_PROBE_URL is required');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('CAUCE_GATE_PROBE_URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CAUCE_GATE_PROBE_URL must be a credential-free HTTPS origin');
  }
  parsed.pathname = '/v3/messages';
  return parsed;
}

async function postJson(url, tls, body, timeoutMs) {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: 'POST', ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: true,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(encoded.byteLength),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > 65_536) {
          response.destroy(new Error('gateway response exceeded the probe bound'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let decoded;
        try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error('gateway returned a non-JSON probe response')); return; }
        resolve({ status: response.statusCode ?? 0, body: decoded });
      });
    });
    outgoing.once('timeout', () => outgoing.destroy(new Error('gateway probe timed out')));
    outgoing.once('error', reject);
    outgoing.end(encoded);
  });
}

async function atomicEvidence(destination, evidence) {
  if (!path.isAbsolute(destination)) throw new Error('evidence output path must be absolute');
  const existing = await lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error('evidence output must not be a symlink');
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main() {
  const target = await targetFromInventory();
  const timeoutMs = boundedInteger('CAUCE_GATE_PROBE_HTTP_TIMEOUT_MS', 15_000, 1_000, 60_000);
  const deliveryTimeoutMs = boundedInteger('CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS', 600_000, 1_000, 1_800_000);
  const [ca, cert, key] = await Promise.all([
    regularFile(process.env.CAUCE_GATE_PROBE_CA_FILE, 'probe CA'),
    regularFile(process.env.CAUCE_GATE_PROBE_CERT_FILE, 'probe certificate'),
    regularFile(process.env.CAUCE_GATE_PROBE_KEY_FILE, 'probe private key', true),
  ]);
  const nonce = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  const response = await postJson(gatewayUrl(), { ca, cert, key }, {
    room_id: target.sourceRoom,
    recipients: [{ tenant_id: target.tenant, alias: target.alias }],
    body: {
      type: 'system.gate.probe',
      nonce,
      timeout_ms: deliveryTimeoutMs,
    },
    idempotency_key: `gate:${target.tenant}:${target.alias}:${nonce}`,
    lane: 'interactive',
    priority: -100,
  }, timeoutMs);
  const deliveryIds = response?.body?.delivery_ids;
  if (response.status !== 202 || !Array.isArray(deliveryIds) || deliveryIds.length !== 1 ||
      typeof deliveryIds[0] !== 'string') {
    throw new Error('gateway did not accept exactly one gate delivery');
  }
  await atomicEvidence(path.resolve(outputFile), {
    schemaVersion: 1,
    tenant: target.tenant,
    alias: target.alias,
    deliveryId: deliveryIds[0],
    nonce,
    startedAt,
  });
  process.stdout.write(`model-free system.gate.probe accepted for ${target.alias}\n`);
}

main().catch((error) => {
  const safe = error instanceof Error && (
    error.message.startsWith('CAUCE_') || error.message.startsWith('probe ') ||
    error.message.startsWith('gate ') || error.message.startsWith('alias ') ||
    error.message.startsWith('evidence ') || error.message.startsWith('gateway ')
  ) ? error.message : 'probe request failed';
  console.error(`round-trip probe failed: ${safe}`);
  process.exitCode = 2;
});

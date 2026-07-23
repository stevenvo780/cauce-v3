#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const fixtureDir = required('CAUCE_FIXTURE_DIR');
const routerDir = required('CAUCE_ROUTER_DIR');
const v2Dir = required('CAUCE_V2_SOCKET_DIR');
const v3Dir = required('CAUCE_V3_SOCKET_DIR');
const ownerUid = Number(process.env.CAUCE_FIXTURE_UID || 1000);
const ownerGid = Number(process.env.CAUCE_FIXTURE_GID || 1000);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function openssl(...args) {
  const result = spawnSync('openssl', args, { cwd: fixtureDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function owned(file, mode) {
  await chmod(file, mode);
  await chown(file, ownerUid, ownerGid);
}

await mkdir(fixtureDir, { recursive: true, mode: 0o700 });
for (const directory of [routerDir, v2Dir, v3Dir]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chown(directory, ownerUid, ownerGid);
}
if (process.env.CAUCE_FIXTURES_PREGENERATED === '1') {
  for (const name of [
    'ca.crt', 'gateway.key', 'gateway.crt', 'client.key', 'client.crt',
    'external.key', 'external.crt', 'mtls-identities.json', 'telegram.token',
    'telegram-config.json', 'v2.marker', 'webhook-provider.mjs', 'shadow-events.jsonl',
  ]) await readFile(path.join(fixtureDir, name));
  console.log(JSON.stringify({ event: 'authentic_fixtures_verified' }));
  process.exit(0);
}
for (const name of [
  'ca.key', 'ca.crt', 'gateway.key', 'gateway.csr', 'gateway.crt',
  'client.key', 'client.csr', 'client.crt', 'external.key', 'external.csr', 'external.crt',
  'gateway.ext', 'client.ext', 'external.ext', 'mtls-identities.json', 'telegram.token',
  'telegram-config.json', 'v2.marker', 'webhook-provider.mjs', 'shadow-events.jsonl',
]) await rm(path.join(fixtureDir, name), { force: true });

openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
  '-subj', '/CN=Cauce Authentic Test CA', '-keyout', 'ca.key', '-out', 'ca.crt');

await writeFile(path.join(fixtureDir, 'gateway.ext'), [
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
  'subjectAltName=DNS:gateway',
  '',
].join('\n'));
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=gateway',
  '-keyout', 'gateway.key', '-out', 'gateway.csr');
openssl('x509', '-req', '-sha256', '-days', '2', '-in', 'gateway.csr', '-CA', 'ca.crt',
  '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'gateway.ext', '-out', 'gateway.crt');

await writeFile(path.join(fixtureDir, 'client.ext'), [
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature,keyEncipherment',
  'extendedKeyUsage=clientAuth',
  '',
].join('\n'));
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=cauce-authentic-client',
  '-keyout', 'client.key', '-out', 'client.csr');
openssl('x509', '-req', '-sha256', '-days', '2', '-in', 'client.csr', '-CA', 'ca.crt',
  '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'client.ext', '-out', 'client.crt');

await writeFile(path.join(fixtureDir, 'external.ext'), [
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
  'subjectAltName=DNS:api.telegram.org,DNS:webhook.test',
  '',
].join('\n'));
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=api.telegram.org',
  '-keyout', 'external.key', '-out', 'external.csr');
openssl('x509', '-req', '-sha256', '-days', '2', '-in', 'external.csr', '-CA', 'ca.crt',
  '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'external.ext', '-out', 'external.crt');

const fingerprint = openssl('x509', '-in', 'client.crt', '-noout', '-fingerprint', '-sha256')
  .split('=', 2)[1].replaceAll(':', '').toLowerCase();
if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('client certificate fingerprint is invalid');
const identities = {
  version: 1,
  identities: [{
    certificate_sha256: fingerprint,
    principal: {
      tenant_id: 'Steven',
      alias: 'kant',
      session_id: 'compose-authentic-mtls',
      channel: 'https',
      roles: ['operator'],
      permissions: ['route', 'read', 'control'],
      origin: {
        adapter: 'webhook',
        channel: 'https',
        conversation_id: 'compose-authentic',
        relay: [],
        metadata: { evidence_class: 'runtime-authentic' },
      },
    },
  }],
};
await writeFile(path.join(fixtureDir, 'mtls-identities.json'), `${JSON.stringify(identities, null, 2)}\n`);

const token = `123456:${randomBytes(24).toString('base64url')}`;
await writeFile(path.join(fixtureDir, 'telegram.token'), `${token}\n`);
await writeFile(path.join(fixtureDir, 'v2.marker'), 'v2-poller-disabled:jarvis\n');
const telegramConfig = {
  aliases: [{
    alias: 'jarvis',
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    token_file: '/fixtures/telegram.token',
    v2_shutdown_marker_file: '/fixtures/v2.marker',
    allowed_user_ids: ['1001'],
    allowed_chat_ids: ['2001'],
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    poll_timeout_seconds: 1,
    poll_lease_ms: 10000,
  }],
};
await writeFile(path.join(fixtureDir, 'telegram-config.json'), `${JSON.stringify(telegramConfig, null, 2)}\n`);
await writeFile(path.join(fixtureDir, 'webhook-provider.mjs'), [
  'export function createWebhookProvider() {',
  '  return {',
  "    async endpoint() { return 'https://webhook.test/hook'; },",
  "    async sign() { return { header: 'x-cauce-signature', value: 'compose-authentic-v1' }; },",
  '  };',
  '}',
  '',
].join('\n'));
await writeFile(path.join(fixtureDir, 'shadow-events.jsonl'), '');

for (const name of [
  'ca.crt', 'gateway.crt', 'client.crt', 'external.crt', 'mtls-identities.json',
  'telegram-config.json', 'v2.marker', 'webhook-provider.mjs', 'shadow-events.jsonl',
]) await owned(path.join(fixtureDir, name), 0o644);
for (const name of ['gateway.key', 'client.key', 'external.key', 'telegram.token']) {
  await owned(path.join(fixtureDir, name), 0o600);
}
for (const name of ['ca.key', 'gateway.csr', 'client.csr', 'external.csr', 'gateway.ext', 'client.ext', 'external.ext']) {
  await chmod(path.join(fixtureDir, name), 0o600);
}

const certDigest = createHash('sha256').update(await readFile(path.join(fixtureDir, 'gateway.crt'))).digest('hex');
console.log(JSON.stringify({ event: 'authentic_fixtures_ready', gatewayCertificateSha256: certDigest }));

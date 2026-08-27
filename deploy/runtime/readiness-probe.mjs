#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const [rawUrl = 'http://127.0.0.1:8080/health/ready', expected = 'ready'] = process.argv.slice(2);
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 3000);
const maximumDatabaseUrlBytes = 65_536;

function assertSafeDatabaseUrlFile(metadata) {
  if (!metadata.isFile()) throw new Error('DATABASE_URL_FILE must be a regular file');
  if ((metadata.mode & 0o444) === 0) throw new Error('DATABASE_URL_FILE is not readable');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('DATABASE_URL_FILE permissions allow group or other access');
  }
  if (metadata.size > maximumDatabaseUrlBytes) throw new Error('DATABASE_URL_FILE is too large');
}

function databaseUrlFrom(contents) {
  const withoutTerminator = contents.endsWith('\r\n')
    ? contents.slice(0, -2)
    : contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (withoutTerminator.includes('\n') || withoutTerminator.includes('\r')) {
    throw new Error('DATABASE_URL_FILE must contain exactly one line');
  }
  if (!withoutTerminator.trim()) throw new Error('DATABASE_URL_FILE is empty');
  if (withoutTerminator !== withoutTerminator.trim()) {
    throw new Error('DATABASE_URL_FILE must not contain surrounding whitespace');
  }
  return withoutTerminator;
}

async function loadDatabaseUrlFile() {
  const file = process.env.DATABASE_URL_FILE;
  if (!file) return;
  if (process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL and DATABASE_URL_FILE cannot both be set');
  }

  let linkMetadata;
  try {
    linkMetadata = await lstat(file);
  } catch {
    throw new Error('DATABASE_URL_FILE is not readable');
  }
  if (linkMetadata.isSymbolicLink()) throw new Error('DATABASE_URL_FILE must not be a symbolic link');
  assertSafeDatabaseUrlFile(linkMetadata);

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error('DATABASE_URL_FILE is not readable');
  }
  try {
    const metadata = await handle.stat();
    assertSafeDatabaseUrlFile(metadata);
    if (metadata.dev !== linkMetadata.dev || metadata.ino !== linkMetadata.ino) {
      throw new Error('DATABASE_URL_FILE changed while opening');
    }
    const contents = await handle.readFile('utf8');
    process.env.DATABASE_URL = databaseUrlFrom(contents);
  } finally {
    await handle.close();
  }
}

async function optionalFile(name) {
  const file = process.env[name];
  return file ? readFile(file) : undefined;
}

try {
  await loadDatabaseUrlFile();
  await assertProductionPostgresTls(timeoutMs);
  const url = new URL(rawUrl);
  const secure = url.protocol === 'https:';
  if (!secure && url.protocol !== 'http:') throw new Error('health URL must use HTTP or HTTPS');
  const [ca, cert, key] = secure
    ? await Promise.all([
      optionalFile('CAUCE_HEALTH_TLS_CA_FILE'),
      optionalFile('CAUCE_HEALTH_TLS_CERT_FILE'),
      optionalFile('CAUCE_HEALTH_TLS_KEY_FILE'),
    ])
    : [];
  if (secure && !ca) throw new Error('CAUCE_HEALTH_TLS_CA_FILE is required for HTTPS health');
  if (secure && ((cert && !key) || (!cert && key))) throw new Error('health client certificate and key must be configured together');
  if (secure && process.env.CAUCE_AUTH_PROVIDER === 'mtls' && (!cert || !key)) {
    throw new Error('mTLS gateway health requires a client certificate and key');
  }
  const body = await new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: globalThis.AbortSignal.timeout(timeoutMs),
      ...(secure ? {
        ca,
        ...(cert && key ? { cert, key } : {}),
        servername: process.env.CAUCE_HEALTH_TLS_SERVERNAME || url.hostname,
        rejectUnauthorized: true,
      } : {}),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65_536) response.destroy(new Error('health response is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.once('error', reject);
    request.end();
  });
  const decoded = JSON.parse(body);
  if (decoded.status !== expected && decoded[expected] !== true) throw new Error(`expected status=${expected}`);
} catch (error) {
  console.error(`readiness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}

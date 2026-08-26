#!/usr/bin/env node

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const requestedPolicy = process.env.CAUCE_POSTGRES_TLS_POLICY ?? '';
if (requestedPolicy !== '' && requestedPolicy !== 'verify-full') {
  console.error('CAUCE_POSTGRES_TLS_POLICY must be verify-full when set');
  process.exit(2);
}

if (process.env.NODE_ENV === 'production' || requestedPolicy === 'verify-full') {
  try {
    let connectionString = process.env.DATABASE_URL;
    const connectionFile = process.env.DATABASE_URL_FILE;
    if (connectionString && connectionFile) {
      throw new Error('set only one PostgreSQL connection source');
    }
    if (!connectionString && connectionFile) {
      if (!isAbsolute(connectionFile)) throw new Error('DATABASE_URL_FILE must be absolute');
      let descriptor;
      try {
        const before = lstatSync(connectionFile);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
            || ![0o400, 0o600].includes(before.mode & 0o777)
            || ![0, process.geteuid?.() ?? -1].includes(before.uid)
            || before.size < 1 || before.size > 16_384) {
          throw new Error('invalid connection file');
        }
        descriptor = openSync(connectionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new Error('connection file changed while opening');
        }
        connectionString = readFileSync(descriptor, 'utf8');
        if (connectionString.endsWith('\n')) connectionString = connectionString.slice(0, -1);
      } catch {
        throw new Error('DATABASE_URL_FILE must be an owned private regular file');
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    if (!connectionString) throw new Error('DATABASE_URL is required');
    if (connectionString.length > 16_384 || connectionString !== connectionString.trim()
        || /[\0\r\n]/u.test(connectionString)) {
      throw new Error('DATABASE_URL has an invalid canonical form');
    }
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
      throw new Error('DATABASE_URL must be a host-based PostgreSQL URL without a fragment');
    }
    const urlModes = url.searchParams.getAll('sslmode');
    const urlRootCertificates = url.searchParams.getAll('sslrootcert');
    if (urlModes.length > 1 || urlRootCertificates.length > 1) {
      throw new Error('PostgreSQL TLS parameters must not be repeated');
    }
    const mode = urlModes[0] ?? process.env.PGSSLMODE ?? '';
    if (mode !== 'verify-full') {
      throw new Error('PostgreSQL requires sslmode=verify-full');
    }
    const rootCertificate = urlRootCertificates[0] ?? process.env.PGSSLROOTCERT ?? '';
    if (!isAbsolute(rootCertificate)) {
      throw new Error('PostgreSQL requires an absolute root CA path');
    }
    let metadata;
    let descriptor;
    try {
      metadata = lstatSync(rootCertificate);
    } catch {
      throw new Error('PostgreSQL root CA is unavailable');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('PostgreSQL root CA must be a regular non-symlink file');
    }
    try {
      descriptor = openSync(rootCertificate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error('root CA changed while it was being verified');
      }
    } catch {
      throw new Error('PostgreSQL root CA is unavailable');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'invalid PostgreSQL TLS policy');
    process.exit(2);
  }
}

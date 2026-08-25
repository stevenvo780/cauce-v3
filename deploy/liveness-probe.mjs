#!/usr/bin/env node

/**
 * Sonda de PROGRESO, no de respuesta.
 *
 * `readiness-probe.mjs` responde a la pregunta "¿el proceso contesta y su Postgres está vivo?".
 * Esa pregunta se contesta que sí con el bucle de trabajo PARADO: el dispatcher puede tener el
 * `setInterval` muerto, el puente puede haber dejado de pedir updates, y el `SELECT 1` sigue
 * saliendo bien. Los nueve contenedores del plano de control decían `healthy` en ese estado.
 *
 * Esta sonda pregunta otra cosa: **¿el contador del bucle AVANZÓ desde la última vez?**. Toma una
 * muestra por ejecución, la guarda, y falla sólo cuando el contador lleva `stallMs` congelado.
 * No confía en ningún reloj ni en ningún cálculo del propio servicio: compara dos observaciones
 * independientes del mismo contador monótono.
 *
 *   node deploy/liveness-probe.mjs <url> <campo> [stallMs]
 *
 * `campo` admite ruta con puntos (`progress.ticks`). Debe ser un contador monótono no negativo.
 *
 * Estados y veredictos:
 *   - sin estado previo            -> se registra la muestra y PASA (arranque; nunca sabemos aún)
 *   - valor mayor que el anterior  -> el bucle avanzó, PASA y se reinicia la ventana
 *   - valor menor que el anterior  -> el proceso reinició, PASA y se reinicia la ventana
 *   - valor igual y edad < stallMs -> PASA (un bucle lento no debe hacer flapear el contenedor)
 *   - valor igual y edad >= stallMs-> FALLA: el bucle está parado
 *
 * El estado vive en un fichero cuyo nombre es un hash de (url, campo): si el contenedor reinicia,
 * el estado se pierde y la sonda vuelve a arrancar, que es exactamente lo correcto — un bucle
 * recién arrancado todavía no tiene derecho a ser declarado muerto.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [rawUrl, rawField, rawStallMs] = process.argv.slice(2);
const timeoutMs = positiveInteger(process.env.HEALTH_TIMEOUT_MS, 3000, 'HEALTH_TIMEOUT_MS');
const stateDirectory = process.env.CAUCE_LIVENESS_STATE_DIR || join(tmpdir(), 'cauce-liveness');
const maximumBodyBytes = 65_536;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Lee `a.b.c` sin heredar nada del prototipo: un cuerpo hostil no puede colar `__proto__`. */
function fieldValue(document, path) {
  let current = document;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function optionalFile(name) {
  const file = process.env[name];
  return file ? readFile(file) : Promise.resolve(undefined);
}

async function fetchHealthDocument(url) {
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
  if (secure && ((cert && !key) || (!cert && key))) {
    throw new Error('health client certificate and key must be configured together');
  }
  const body = await new Promise((resolve, reject) => {
    const call = (secure ? httpsRequest : httpRequest)({
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
        if (size > maximumBodyBytes) response.destroy(new Error('health response is too large'));
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
    call.once('error', reject);
    call.end();
  });
  return JSON.parse(body);
}

function statePath(url, field) {
  const digest = createHash('sha256').update(`${url}\u0000${field}`).digest('hex').slice(0, 32);
  return join(stateDirectory, `${digest}.json`);
}

async function readState(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const decoded = JSON.parse(contents);
    const value = Number(decoded?.value);
    const since = Number(decoded?.since);
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (!Number.isSafeInteger(since) || since <= 0) return undefined;
    return { value, since };
  } catch {
    // Un estado corrupto no puede tumbar el contenedor: se trata como primera observación.
    return undefined;
  }
}

/** Escritura atómica y 0600: el fichero de estado no lleva secretos, pero tampoco se comparte. */
async function writeState(path, state) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

try {
  if (!rawUrl || !rawField) {
    throw new Error('usage: liveness-probe.mjs <url> <progress-field> [stallMs]');
  }
  const stallMs = positiveInteger(rawStallMs, 60_000, 'stallMs');
  const url = new URL(rawUrl);
  const document = await fetchHealthDocument(url);
  const raw = fieldValue(document, rawField);
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`progress field ${rawField} is missing or not a counter`);
  }

  const path = statePath(rawUrl, rawField);
  const previous = await readState(path);
  const now = Date.now();

  if (!previous || value !== previous.value) {
    // Avanzó (o el proceso reinició y el contador volvió atrás): ventana nueva.
    await writeState(path, { value, since: now });
    process.exit(0);
  }

  const stalledMs = now - previous.since;
  if (stalledMs >= stallMs) {
    throw new Error(`progress stalled: ${rawField} frozen at ${value} for ${stalledMs}ms (limit ${stallMs}ms)`);
  }
  process.exit(0);
} catch (error) {
  console.error(`liveness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}

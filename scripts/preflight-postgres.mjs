#!/usr/bin/env node
/**
 * Fails closed BEFORE any suite opens a pool. A missing CAUCE_TEST_DATABASE_URL, a database whose
 * name is not a test one, or a cluster that does not answer must read as two Spanish lines telling
 * the operator what to start — never as a `pg` connection stack buried under a suite that timed out.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';

/** Same criterion as `esBaseDePruebas` in tests/helpers/postgres.ts: the suites TRUNCATE tables. */
const PREFIJO_BASE_DE_PRUEBAS = 'cauce_test';
const DOCUMENTO = 'docs/entorno-de-desarrollo-con-base-real.md';
const ARRANQUE = `Arráncala con \`sudo pg_ctlcluster 16 main start\`; el procedimiento está en ${DOCUMENTO}.`;
const SOLO_BASE_DE_PRUEBAS = `Sólo se acepta la base de pruebas que describe ${DOCUMENTO}.`;
const ESPERA_MS = 3_000;
const PUERTO_POR_DEFECTO = 5432;

function fallar(primera, segunda) {
  process.stderr.write(`${primera}\n${segunda}\n`);
  process.exit(1);
}

function destinoDe(url) {
  try {
    const partes = new URL(url);
    return {
      host: partes.hostname === '' ? '127.0.0.1' : partes.hostname,
      puerto: partes.port === '' ? PUERTO_POR_DEFECTO : Number(partes.port),
      base: decodeURIComponent(partes.pathname.replace(/^\//u, '')),
    };
  } catch {
    return undefined;
  }
}

/** `pg_isready` distinguishes "accepting connections" from "starting up"; a socket probe cannot. */
function sondaDePgIsready(host, puerto) {
  const sonda = spawnSync('pg_isready', ['-h', host, '-p', String(puerto), '-t', '3'], { encoding: 'utf8' });
  if (sonda.error) return undefined;
  if (sonda.status === 0) return { motivo: undefined };
  const dicho = `${sonda.stdout ?? ''}${sonda.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  return { motivo: dicho === '' ? `pg_isready salió ${String(sonda.status)}` : dicho };
}

/** A server that answers is not a database that exists: only a real connection proves the name. */
function conexionReal(url) {
  const intento = spawnSync('psql', [url, '-tAc', 'select 1'], { encoding: 'utf8', timeout: ESPERA_MS * 2 });
  if (intento.error) return undefined;
  if (intento.status === 0) return { motivo: undefined };
  const dicho = `${intento.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  return { motivo: dicho === '' ? `psql salió ${String(intento.status)}` : dicho };
}

function sondaDeSocket(host, puerto) {
  return new Promise((resolver) => {
    const socket = connect({ host, port: puerto });
    const terminar = (motivo) => {
      socket.destroy();
      resolver({ motivo });
    };
    socket.setTimeout(ESPERA_MS);
    socket.once('connect', () => terminar(undefined));
    socket.once('timeout', () => terminar(`el puerto no respondió en ${String(ESPERA_MS)} ms`));
    socket.once('error', (error) => terminar(error.code ?? error.message));
  });
}

async function main() {
  const url = process.env.CAUCE_TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    fallar(
      'Falta la base de pruebas: exporta CAUCE_TEST_DATABASE_URL='
        + `"postgresql://cauce@127.0.0.1:${String(PUERTO_POR_DEFECTO)}/${PREFIJO_BASE_DE_PRUEBAS}".`,
      ARRANQUE,
    );
  }
  const destino = destinoDe(url);
  if (destino === undefined) fallar('CAUCE_TEST_DATABASE_URL no es una URL válida de Postgres.', SOLO_BASE_DE_PRUEBAS);
  if (!destino.base.startsWith(PREFIJO_BASE_DE_PRUEBAS)) {
    fallar(
      `CAUCE_TEST_DATABASE_URL apunta a la base "${destino.base}" y las suites TRUNCAN tablas: `
        + `sólo se acepta un nombre que empiece por "${PREFIJO_BASE_DE_PRUEBAS}".`,
      SOLO_BASE_DE_PRUEBAS,
    );
  }
  const donde = `${destino.host}:${String(destino.puerto)}`;
  const sonda = sondaDePgIsready(destino.host, destino.puerto) ?? await sondaDeSocket(destino.host, destino.puerto);
  if (sonda.motivo !== undefined) {
    fallar(`La base de pruebas no responde en ${donde} (${sonda.motivo}).`, ARRANQUE);
  }
  const conexion = conexionReal(url);
  if (conexion === undefined) {
    process.stdout.write(`preflight: el servidor responde en ${donde}; sin psql no se comprobó que exista "${destino.base}".\n`);
    return;
  }
  if (conexion.motivo !== undefined) {
    if (/does not exist/u.test(conexion.motivo)) {
      fallar(`La base "${destino.base}" no existe en ${donde}: créala con \`createdb -h ${destino.host} -p ${String(destino.puerto)} ${destino.base}\`.`, ARRANQUE);
    }
    fallar(`No se pudo conectar a "${destino.base}" en ${donde} (${conexion.motivo}).`, ARRANQUE);
  }
  process.stdout.write(`preflight: base de pruebas "${destino.base}" disponible en ${donde}.\n`);
}

await main();

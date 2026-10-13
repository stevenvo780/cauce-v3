/*
 * CAUCE_TEST_SHARD for vitest. It filters in sort() rather than through test.shard so that an
 * invocation whose filters match nothing still dies with "No test files found", as it does unsharded:
 * passWithNoTests is relaxed only for a shard whose slice of a non-empty file set is empty.
 */
import { availableParallelism } from 'node:os';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { elegir, leerTrozo, RAIZ, registrarReparto } from './trozos.mjs';

class SecuenciadorDeTrozo extends BaseSequencer {
  async sort(files) {
    const trozo = leerTrozo();
    if (!trozo) return super.sort(files);
    const raiz = this.ctx.config.root;
    const ficheros = [...new Set(files.map((spec) => relative(raiz, spec.moduleId)))].sort();
    const elegidos = new Set(elegir(ficheros, trozo));
    registrarReparto(trozo, {
      suite: process.env.CAUCE_TEST_SUITE ?? 'manual', cwd: relative(RAIZ, raiz), ficheros, elegidos,
    });
    if (elegidos.size === 0) this.ctx.config.passWithNoTests = true;
    return super.sort(files.filter((spec) => elegidos.has(relative(raiz, spec.moduleId))));
  }
}

export function opcionesDeTrozo({ repartirTrabajadores = false } = {}, entorno = process.env) {
  const trozo = leerTrozo(entorno.CAUCE_TEST_SHARD);
  if (!trozo) return {};
  return {
    sequence: { sequencer: SecuenciadorDeTrozo },
    ...(repartirTrabajadores ? { maxWorkers: Math.max(2, Math.floor(availableParallelism() / trozo.total)) } : {}),
  };
}

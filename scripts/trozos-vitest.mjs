/* CAUCE_TEST_SHARD for vitest, filtered in sort() and not through test.shard: an invocation that matches
   no file still dies with "No test files found"; passWithNoTests is relaxed only for an empty slice.
   The configs load it only when CAUCE_TEST_SHARD is set, by a URL tsc does not follow (the release image
   copies vitest.config.ts and console/, not scripts/). It consumes the shard variables and removes them
   from the environment, so a test that starts its own runner is not sharded. */
import { availableParallelism } from 'node:os';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { elegir, leerTrozo, RAIZ, registrarReparto, VARIABLES_DE_TROZO } from './trozos.mjs';

export function opcionesDeTrozo({ repartirTrabajadores = false } = {}, entorno = process.env) {
  const trozo = leerTrozo(entorno.CAUCE_TEST_SHARD);
  if (!trozo) return {};
  const directorio = entorno.CAUCE_TEST_SHARD_DIR;
  const suite = entorno.CAUCE_TEST_SUITE ?? 'manual';
  for (const nombre of VARIABLES_DE_TROZO) delete entorno[nombre];

  class SecuenciadorDeTrozo extends BaseSequencer {
    async sort(files) {
      const raiz = this.ctx.config.root;
      const ficheros = [...new Set(files.map((spec) => relative(raiz, spec.moduleId)))].sort();
      const elegidos = new Set(elegir(ficheros, trozo));
      registrarReparto(trozo, { suite, cwd: relative(RAIZ, raiz), ficheros, elegidos }, directorio);
      if (elegidos.size === 0) this.ctx.config.passWithNoTests = true;
      return super.sort(files.filter((spec) => elegidos.has(relative(raiz, spec.moduleId))));
    }
  }

  return {
    sequence: { sequencer: SecuenciadorDeTrozo },
    ...(repartirTrabajadores ? { maxWorkers: Math.max(2, Math.floor(availableParallelism() / trozo.total)) } : {}),
  };
}

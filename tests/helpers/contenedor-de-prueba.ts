// What every test PostgreSQL container carries, wherever it is started: the per-file server of
// postgres.ts and the fixtures that mount their own template server.
import { availableParallelism } from 'node:os';
import type { GenericContainer } from 'testcontainers';
import { conPlazaDelGate } from './plazas-del-anfitrion.js';

export const COMANDO_POSTGRES_DE_PRUEBA: readonly string[] = [ // non-durable: docs/entorno-de-desarrollo-con-base-real.md
  'postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off',
];

// Over TCP: the image's init server listens only on the Unix socket, so a socket probe passes before port 5432 opens.
export function saludDePostgresDePrueba(usuario: string, base: string): Parameters<GenericContainer['withHealthCheck']>[0] {
  return {
    test: ['CMD-SHELL', `pg_isready -h 127.0.0.1 -p 5432 -U ${usuario} -d ${base}`],
    interval: 1_000, timeout: 3_000, retries: 120, startPeriod: 1_000,
  };
}

export function etiquetasDelPasoDelGate(entorno: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const paso = entorno.CAUCE_RELEASE_GATES_PASO; // el gate retira por esta etiqueta lo que un paso cortado deja
  return paso ? { 'io.cauce.gate.paso': paso } : {};
}

/** Under the release gate at most one test server per CPU boots at once: initdb is CPU-bound. */
export function arrancarPostgresDePrueba<T>(arrancar: () => Promise<T>): Promise<T> {
  return conPlazaDelGate('CAUCE_ARRANQUES_POSTGRES', availableParallelism(), arrancar);
}

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    carrilExclusivo: string;
  }
}

export const TURNO = 'turno\n';

/**
 * The whole-stack suites (browser, relay, PTY) run one file at a time among themselves, as they
 * always did, without serializing the rest of the run with them: this is the lane they queue on.
 *
 * A first-come queue behind a Unix socket owned by the main vitest process. The turn belongs to
 * the connection, not to a file the worker promises to delete, so a worker that dies mid-file
 * frees it on the spot: the kernel closes its socket and the next file in the queue starts.
 */
export default async function carrilExclusivo(project: TestProject): Promise<() => Promise<void>> {
  const directorio = await mkdtemp(join(tmpdir(), 'cauce-carril-'));
  const ruta = join(directorio, 'carril.sock');
  const cola: Socket[] = [];
  const abiertos = new Set<Socket>();
  let titular: Socket | undefined;

  const conceder = (): void => {
    while (titular === undefined) {
      const siguiente = cola.shift();
      if (siguiente === undefined) return;
      if (siguiente.destroyed) continue;
      titular = siguiente;
      siguiente.write(TURNO);
    }
  };

  const servidor = createServer((socket) => {
    abiertos.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      abiertos.delete(socket);
      if (titular === socket) titular = undefined;
      const enCola = cola.indexOf(socket);
      if (enCola >= 0) cola.splice(enCola, 1);
      conceder();
    });
    cola.push(socket);
    conceder();
  });
  await new Promise<void>((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(ruta, () => {
      servidor.removeListener('error', reject);
      resolve();
    });
  });
  project.provide('carrilExclusivo', ruta);

  return async () => {
    for (const socket of abiertos) socket.destroy();
    await new Promise<void>((resolve) => {
      servidor.close(() => {
        resolve();
      });
    });
    await rm(directorio, { recursive: true, force: true });
  };
}

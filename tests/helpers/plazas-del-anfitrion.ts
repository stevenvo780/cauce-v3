import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';

export type SoltarPlaza = () => Promise<void>;

/*
 * A host-wide seat is an abstract Unix socket named after the gate run's scope: binding is atomic, only one
 * process holds each name, and the kernel unbinds it when its holder dies, so a crashed holder never leaves a
 * seat taken and no two waiters can reclaim the same one. Abstract names live in the network namespace, which
 * every process of a gate run shares.
 */
function enlazar(nombre: string): Promise<Server | undefined> {
  return new Promise((resuelto, rechazado) => {
    const servidor = createServer();
    servidor.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resuelto(undefined);
      else rechazado(error);
    });
    servidor.listen({ path: nombre, exclusive: true }, () => {
      servidor.unref();
      resuelto(servidor);
    });
  });
}

export function nombreDePlaza(ambito: string, indice: number): string {
  const huella = createHash('sha256').update(resolve(ambito)).digest('hex').slice(0, 32);
  return `\0cauce-plaza-${huella}-${String(indice)}`;
}

export async function tomarPlaza(ambito: string, plazas: number, sondeoMs = 200): Promise<SoltarPlaza> {
  if (!Number.isInteger(plazas) || plazas < 1) throw new Error(`plazas del anfitrión inválidas: ${String(plazas)}`);
  for (;;) {
    for (let indice = 0; indice < plazas; indice += 1) {
      const servidor = await enlazar(nombreDePlaza(ambito, indice));
      if (servidor === undefined) continue;
      let soltada: Promise<void> | undefined;
      return () => {
        soltada ??= new Promise<void>((listo) => { servidor.close(() => { listo(); }); });
        return soltada;
      };
    }
    await new Promise((listo) => setTimeout(listo, sondeoMs));
  }
}

/** The seats a gate run exports as `<prefix>_HOST` (its scope) and `<prefix>_PLAZAS`; none outside a gate. */
export function plazasDelGate(
  prefijo: string, porDefecto: number, entorno: NodeJS.ProcessEnv = process.env,
): { ambito: string; plazas: number } | undefined {
  const ambito = entorno[`${prefijo}_HOST`];
  if (!ambito) return undefined;
  const crudo = entorno[`${prefijo}_PLAZAS`];
  const plazas = Number(crudo ?? String(porDefecto));
  if (!Number.isInteger(plazas) || plazas < 1) throw new Error(`${prefijo}_PLAZAS inválido: ${String(crudo)}`);
  return { ambito, plazas };
}

export async function conPlazaDelGate<T>(prefijo: string, porDefecto: number, tarea: () => Promise<T>): Promise<T> {
  const asiento = plazasDelGate(prefijo, porDefecto);
  if (asiento === undefined) return tarea();
  const soltar = await tomarPlaza(asiento.ambito, asiento.plazas);
  try {
    return await tarea();
  } finally {
    await soltar();
  }
}

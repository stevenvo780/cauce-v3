import { createServer, type AddressInfo } from 'node:net';

export interface LoopbackPortReservation {
  readonly port: number;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface NamedLoopbackPortReservations<K extends string = string> {
  readonly ports: Record<K, number>;
  readonly reservations: Record<K, LoopbackPortReservation>;
  release(name: K): Promise<void>;
  releaseAll(): Promise<void>;
}

export async function reserveLoopbackPort(host = '127.0.0.1'): Promise<LoopbackPortReservation> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    try {
      await closeServer(server);
    } catch (error) {
      throw new AggregateError([new Error('failed to determine reserved loopback port address'), error],
        'port reservation failed and its listener could not be closed');
    }
    throw new Error('failed to determine reserved loopback port address');
  }

  const port = address.port;
  let isReleased = false;
  let releasePromise: Promise<void> | undefined;

  return {
    port,
    get released() {
      return isReleased;
    },
    release() {
      if (isReleased) return Promise.resolve();
      if (releasePromise) return releasePromise;

      releasePromise = closeServer(server).then(() => {
        isReleased = true;
      }, (error: unknown) => {
        releasePromise = undefined;
        throw error;
      });
      return releasePromise;
    },
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function releaseReservations(reservations: LoopbackPortReservation[], message: string): Promise<void> {
  const results = await Promise.allSettled(reservations.map((reservation) => reservation.release()));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, message);
}

export async function reserveNamedLoopbackPorts<const K extends readonly string[]>(
  names: K,
  host = '127.0.0.1',
): Promise<NamedLoopbackPortReservations<K[number]>> {
  const reservations: Partial<Record<K[number], LoopbackPortReservation>> = {};
  const activeReservations: LoopbackPortReservation[] = [];

  try {
    for (const name of names) {
      const reservation = await reserveLoopbackPort(host);
      reservations[name as K[number]] = reservation;
      activeReservations.push(reservation);
    }
  } catch (error) {
    try {
      await releaseReservations(activeReservations, 'failed to release partially allocated loopback ports');
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'port allocation failed and cleanup was incomplete', { cause: error });
    }
    throw error;
  }

  const ports = Object.fromEntries(
    Object.entries(reservations).map(([name, reservation]) => [name, (reservation as LoopbackPortReservation).port]),
  ) as Record<K[number], number>;

  const release = async (name: K[number]) => {
    const reservation = reservations[name];
    if (reservation) {
      await reservation.release();
    }
  };

  const releaseAll = async () => {
    await releaseReservations(activeReservations, 'one or more reserved loopback ports could not be released');
  };

  return {
    ports,
    reservations: reservations as Record<K[number], LoopbackPortReservation>,
    release,
    releaseAll,
  };
}

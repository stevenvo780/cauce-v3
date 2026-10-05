import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { reserveLoopbackPort, reserveNamedLoopbackPorts } from './port-reservation.js';

async function attemptListen(port: number, host = '127.0.0.1'): Promise<{ server?: Server; error?: unknown }> {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once('error', (error) => {
      resolve({ error });
    });
    server.listen(port, host, () => {
      resolve({ server });
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

describe('port-reservation helper', () => {
  it('reserves 5 distinct ports concurrently with zero overlap', async () => {
    const names = ['browser', 'agent', 'health', 'gateway', 'frontend'] as const;
    const reserved = await reserveNamedLoopbackPorts(names);

    try {
      const ports = Object.values(reserved.ports);
      expect(ports).toHaveLength(5);
      for (const port of ports) {
        expect(port).toBeGreaterThan(0);
      }
      expect(new Set(ports).size).toBe(5);
    } finally {
      await reserved.releaseAll();
    }
  });

  it('rejects competing listeners with EADDRINUSE before handoff', async () => {
    const names = ['browser', 'agent', 'health', 'gateway', 'frontend'] as const;
    const reserved = await reserveNamedLoopbackPorts(names);

    try {
      for (const [name, port] of Object.entries(reserved.ports)) {
        const attempt = await attemptListen(port);
        expect(attempt.server, `server unexpectedly bound reserved port ${name}:${String(port)}`).toBeUndefined();
        const err = attempt.error as NodeJS.ErrnoException;
        expect(err.code).toBe('EADDRINUSE');
      }
    } finally {
      await reserved.releaseAll();
    }
  });

  it('permits granular handoff and binding right after specific release', async () => {
    const names = ['browser', 'agent', 'health', 'gateway', 'frontend'] as const;
    const reserved = await reserveNamedLoopbackPorts(names);

    try {
      const targetPort = reserved.ports.gateway;
      const priorAttempt = await attemptListen(targetPort);
      expect(priorAttempt.server).toBeUndefined();
      expect((priorAttempt.error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');

      await reserved.release('gateway');

      const handoffAttempt = await attemptListen(targetPort);
      expect(handoffAttempt.error).toBeUndefined();
      expect(handoffAttempt.server).toBeDefined();

      await closeServer(handoffAttempt.server);
    } finally {
      await reserved.releaseAll();
    }
  });

  it('verifies full cleanup on releaseAll and idempotent release calls', async () => {
    const names = ['browser', 'agent', 'health', 'gateway', 'frontend'] as const;
    const reserved = await reserveNamedLoopbackPorts(names);

    const ports = Object.values(reserved.ports);
    await reserved.releaseAll();

    await expect(reserved.releaseAll()).resolves.toBeUndefined();
    await expect(reserved.release('health')).resolves.toBeUndefined();

    for (const port of ports) {
      const attempt = await attemptListen(port);
      expect(attempt.error).toBeUndefined();
      expect(attempt.server).toBeDefined();
      await closeServer(attempt.server);
    }
  });

  it('cleans up single reservation independently', async () => {
    const reservation = await reserveLoopbackPort();
    expect(reservation.port).toBeGreaterThan(0);
    expect(reservation.released).toBe(false);

    const blocked = await attemptListen(reservation.port);
    expect(blocked.server).toBeUndefined();
    expect((blocked.error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');

    await reservation.release();
    expect(reservation.released).toBe(true);

    await expect(reservation.release()).resolves.toBeUndefined();

    const allowed = await attemptListen(reservation.port);
    expect(allowed.error).toBeUndefined();
    expect(allowed.server).toBeDefined();
    await closeServer(allowed.server);
  });

  it('coalesces concurrent releases and marks the reservation released only after close completes', async () => {
    const reservation = await reserveLoopbackPort();
    const release = reservation.release();
    const concurrentRelease = reservation.release();

    expect(concurrentRelease).toBe(release);
    expect(reservation.released).toBe(false);
    await Promise.all([release, concurrentRelease]);
    expect(reservation.released).toBe(true);

    const listener = await attemptListen(reservation.port);
    expect(listener.error).toBeUndefined();
    expect(listener.server).toBeDefined();
    await closeServer(listener.server);
  });

  it('reports cleanup failures and still releases every other reservation', async () => {
    const names = ['agent', 'health', 'gateway'] as const;
    const reserved = await reserveNamedLoopbackPorts(names);
    const ports = Object.values(reserved.ports);
    const failedReservation = reserved.reservations.agent;
    const actualRelease = failedReservation.release.bind(failedReservation);
    const cleanupFailure = new Error('simulated close callback failure');
    failedReservation.release = () => Promise.reject(cleanupFailure);

    try {
      await expect(reserved.releaseAll()).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [cleanupFailure],
      });
      for (const name of ['health', 'gateway'] as const) {
        expect(reserved.reservations[name].released).toBe(true);
      }
    } finally {
      await actualRelease();
    }

    for (const port of ports) {
      const listener = await attemptListen(port);
      expect(listener.error).toBeUndefined();
      expect(listener.server).toBeDefined();
      await closeServer(listener.server);
    }
  });
});

import { connect, createServer } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { cliAcceptsDatabaseHostWithoutTls, forwardTcpToLoopback, publishCliDatabase } from '../e2e/cli-database-loopback.js';

async function acceptedDatabaseUrl(url: string): Promise<string> {
  const imported: unknown = await import(new URL('../../ops/cli/platform_admin.mjs', import.meta.url).href);
  if (typeof imported !== 'object' || imported === null || !('databaseUrl' in imported)) throw new Error('databaseUrl export missing');
  const databaseUrl = imported.databaseUrl;
  if (typeof databaseUrl !== 'function') throw new Error('databaseUrl export missing');
  const accepted: unknown = await (databaseUrl as (environment: { DATABASE_URL: string }) => Promise<unknown>)({ DATABASE_URL: url });
  if (typeof accepted !== 'string') throw new Error('databaseUrl did not return a string');
  return accepted;
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pending = closers.splice(0);
  await Promise.all(pending.map((close) => close()));
});

describe('CLI database URL when Testcontainers returns the lab VM', () => {
  test('keeps a loopback container address unchanged', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const published = await publishCliDatabase('cauce_test', 's3cret/value', host, 5432, 'cauce_test');
      closers.push(() => published.close());
      expect(published.cliUrl).toBe(published.directUrl);
      expect(published.directUrl).toContain(`@${host}:5432/`);
    }
    expect(cliAcceptsDatabaseHostWithoutTls('10.88.88.43')).toBe(false);
  });

  test('gives the CLI a loopback URL and leaves the pool on the VM address', async () => {
    const published = await publishCliDatabase('cauce_test', 's3cret/value', '10.88.88.43', 5432, 'cauce_test');
    closers.push(() => published.close());
    const cli = new URL(published.cliUrl);
    const direct = new URL(published.directUrl);
    expect(cli.hostname).toBe('127.0.0.1');
    expect(cli.pathname).toBe('/cauce_test');
    expect(decodeURIComponent(cli.password)).toBe('s3cret/value');
    expect(direct.hostname).toBe('10.88.88.43');
    expect(direct.port).toBe('5432');
    expect(cli.port).not.toBe('5432');
    await expect(acceptedDatabaseUrl(published.cliUrl)).resolves.toBe(published.cliUrl);
    await expect(acceptedDatabaseUrl(published.directUrl)).rejects.toThrow(/sslmode/);
  });

  test('forwards bytes from the loopback port to the upstream', async () => {
    const echo = createServer((socket) => { socket.pipe(socket); });
    closers.push(async () => {
      if (!echo.listening) return;
      await new Promise<void>((done, reject) => { echo.close((error) => { if (error) reject(error); else done(); }); });
    });
    await new Promise<void>((done, reject) => {
      echo.once('error', reject);
      echo.listen(0, '127.0.0.1', () => { echo.off('error', reject); done(); });
    });
    const address = echo.address();
    if (!address || typeof address === 'string') throw new Error('echo port unavailable');
    const forward = await forwardTcpToLoopback('127.0.0.1', address.port);
    closers.push(() => forward.close());
    const received = await new Promise<string>((done, reject) => {
      const client = connect({ host: '127.0.0.1', port: forward.port });
      let payload = '';
      client.setTimeout(2_000, () => { client.destroy(); reject(new Error('forward timed out')); });
      client.on('error', reject);
      client.on('data', (chunk: Buffer) => {
        payload += chunk.toString();
        if (payload === 'ping') { client.end(); done(payload); }
      });
      client.on('connect', () => { client.write('ping'); });
    });
    expect(received).toBe('ping');
  });
});

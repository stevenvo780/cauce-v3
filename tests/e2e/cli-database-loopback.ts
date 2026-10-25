import { connect, createServer, type Server, type Socket } from 'node:net';

export interface PublishedCliDatabase {
  readonly directUrl: string;
  readonly cliUrl: string;
  close(): Promise<void>;
}

export interface LoopbackForward {
  readonly port: number;
  close(): Promise<void>;
}

/** Same loopback predicate as ops/cli/platform_admin.mjs databaseUrl(). */
export function cliAcceptsDatabaseHostWithoutTls(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(host);
}

export function postgresUrl(user: string, password: string, host: string, port: number, database: string): string {
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`;
}

function closeForward(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return Promise.resolve();
  return new Promise((done, reject) => {
    server.close((error) => { if (error) reject(error); else done(); });
  });
}

export async function forwardTcpToLoopback(host: string, port: number): Promise<LoopbackForward> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => { sockets.delete(client); });
    const upstream = connect({ host, port });
    sockets.add(upstream);
    upstream.once('close', () => { sockets.delete(upstream); });
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    upstream.on('error', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  // A bind error rejects the listen promise. A later error must not take down the runner.
  server.on('error', () => {
    return;
  });
  await new Promise<void>((done, reject) => {
    const fail = (error: Error) => { reject(error); };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeForward(server, sockets);
    throw new Error('CLI database forwarder did not bind a loopback port');
  }
  return { port: address.port, close: () => closeForward(server, sockets) };
}

/** The pool keeps the container address. The CLI file is loopback, so production TLS stays mandatory for remote URLs. */
export async function publishCliDatabase(
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): Promise<PublishedCliDatabase> {
  const directUrl = postgresUrl(user, password, host, port, database);
  if (cliAcceptsDatabaseHostWithoutTls(host)) {
    return { directUrl, cliUrl: directUrl, close: async () => undefined };
  }
  const forward = await forwardTcpToLoopback(host, port);
  return {
    directUrl,
    cliUrl: postgresUrl(user, password, '127.0.0.1', forward.port, database),
    close: () => forward.close(),
  };
}

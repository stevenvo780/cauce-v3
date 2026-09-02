import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';

interface FailureState {
  destroyedClients: number;
  next?: { fragment: string; code: string };
}

interface InstrumentedClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(destroy?: boolean): void;
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
}

interface InstrumentedPool {
  connect(): Promise<InstrumentedClient>;
}

interface BrokenClientTestDatabase {
  pool: object;
  sessions: ReadonlyMap<string, { browser_owner_generation: string }>;
  audit: readonly { action: string }[];
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface BrokenClientTestDependencies {
  app: FastifyInstance;
  database: BrokenClientTestDatabase;
  openSession: (body: Record<string, unknown>) => Promise<InjectResponse>;
  prepare: () => Promise<void>;
}

const failures = new WeakMap<object, FailureState>();

function failureState(pool: object): FailureState {
  const state = failures.get(pool);
  if (state === undefined) throw new Error('transaction failure pool is not instrumented');
  return state;
}

export function instrumentFailurePool<T extends object>(pool: T): T {
  const candidate = pool as T & InstrumentedPool;
  const connect = candidate.connect.bind(candidate);
  const state: FailureState = { destroyedClients: 0 };
  candidate.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    let released = false;
    client.query = async (text, values = []) => {
      if (state.next !== undefined && text.includes(state.next.fragment)) {
        const { code, fragment } = state.next;
        delete state.next;
        throw Object.assign(new Error(`forced client query failure: ${fragment}`), { code });
      }
      return query(text, values);
    };
    client.on ??= () => undefined;
    client.off ??= () => undefined;
    client.release = (destroy) => {
      if (!released && destroy === true) state.destroyedClients += 1;
      released = true;
      release(destroy);
    };
    return client;
  };
  failures.set(pool, state);
  return pool;
}

export function registerBrokenClientTest(
  dependencies: () => BrokenClientTestDependencies,
  origin: string,
): void {
  it('destroys a checked-out client after a connection-class transaction failure', async () => {
    const { app, database, openSession, prepare } = dependencies();
    await prepare();
    const ownerToken = crypto.randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const payload = {
      request_id: issued.request_id,
      expected_owner_generation: issued.owner_generation,
      owner_token: crypto.randomUUID(),
    };
    const state = failureState(database.pool);
    state.next = { fragment: 'SET browser_owner_sha256=$4', code: '08006' };

    const failed = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin },
      payload,
    });
    expect(failed.statusCode).toBe(400);
    expect(state.destroyedClients).toBe(1);
    expect(database.sessions.get(issued.session_id)?.browser_owner_generation).toBe('1');
    expect(database.audit.some((row) => row.action === 'terminal.session.owner_rotated')).toBe(false);

    const retried = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin },
      payload,
    });
    expect(retried.statusCode).toBe(200);
    expect(database.sessions.get(issued.session_id)?.browser_owner_generation).toBe('2');
  });
}

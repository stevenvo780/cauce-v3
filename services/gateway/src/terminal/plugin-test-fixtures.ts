import { createHash } from 'node:crypto';
import { authorityContinuityCommitment, issueAuthorityContinuity, verifyAuthorityContinuity } from './authority-continuity.js';
import { expect } from 'vitest';
import { fakeDatabase as legacyFakeDatabase, MASTER, type FakeDatabase } from '../terminal.plugin.shared.js';

export * from '../terminal.plugin.shared.js';

interface QueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}
interface QueryPool {
  connect(): Promise<QueryClient>;
}

// The shared fixture retains the historical parameter layout for other suites.
export function fakeDatabase(): FakeDatabase {
  const database = legacyFakeDatabase();
  const pool = database.pool as unknown as QueryPool;
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (text, values = []) => {
      if (text.includes('decision AS MATERIALIZED') && text.includes('INSERT INTO terminal_sessions')) {
        expect(text).toContain("$13,$14,'',$15,$16");
        expect(values).toHaveLength(24);
        return query(text, [...values.slice(0, 14), '', ...values.slice(14)]);
      }
      return query(text, values);
    };
    return client;
  };
  return database;
}

export function installLegacyAdmission(database: FakeDatabase, sessionId: string): string {
  const row = database.sessions.get(sessionId);
  const proof = database.authorityProofs.get(sessionId);
  if (row === undefined || proof === undefined) throw new Error('legacy admission fixture is unavailable');
  const previous = verifyAuthorityContinuity(proof, MASTER);
  const material = {
    suite: 'cauce-v3-terminal-browser-admission', version: 2, request_id: row.request_id,
    actor: { tenant_id: previous.origin.actor.tenantId, alias: previous.origin.actor.alias },
    operator: { operator_id: row.operator_id, attributed: row.attributed, console_subject: row.console_subject },
    target: { tenant_id: row.tenant_id, alias: row.alias, container: row.container,
      presence_generation: row.generation, image_id: row.image_id, runtime_user: row.runtime_user,
      runtime_uid: 1000, mode: row.mode, relay_instance_id: row.relay_instance_id },
    reason: 'historical human justification', cols: row.cols, rows: row.rows,
  };
  const payload = { ...previous, semanticDigest: createHash('sha256').update(JSON.stringify(material)).digest('hex') };
  const legacyProof = issueAuthorityContinuity(payload, MASTER);
  row.reason = material.reason;
  row.request_sha256 = authorityContinuityCommitment(payload);
  database.authorityProofs.set(sessionId, legacyProof);
  return legacyProof;
}

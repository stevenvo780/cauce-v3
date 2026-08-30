import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { AuthError, type AuthProvider, type Principal } from './auth.js';
import type { RelayFileRead, RuntimeFacts } from './console/agent-documents.js';
import type { FactsSource, GovernanceReadError } from './console/agent-documents.routes.js';
import type { AgentDirective } from './console/types-agent-directive.js';
import { createConsoleSecurityHook } from './console-security.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';
import { AGENT_STALE_AFTER_MS, AgentRegistry } from './terminal/registry.js';
import {
  deriveAliasKey, issueResumeToken, parseAndVerify, verifyTicketSignature,
} from './terminal/tickets.js';
import { UNATTRIBUTED_OPERATOR, type AgentPresence, type TerminalSessionRow } from './terminal/types.js';

/**
 * Control-plane behaviour end to end over app.inject, with the same console security hook
 * app.ts installs in production. The database is a substitute: these tests are about the
 * decisions and the audit trail, not about PostgreSQL.
 */

const ORIGIN = 'https://consola.elenxos.com';
const RELAY_TOKEN = 'relay-token-that-is-long-enough-0123456789';
const MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');
const CLAIM_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_B = '22222222-2222-4222-8222-222222222222';
const RELAY_A = 'a'.repeat(64);
const RELAY_B = 'b'.repeat(64);
const RELAY_BOOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RELAY_BOOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface AuditRow {
  tenant_id: string;
  actor_alias: string;
  action: string;
  decision: string;
  metadata: Record<string, unknown>;
}

interface FakeDatabase {
  pool: DatabasePool;
  clock: { now: () => number };
  sessions: Map<string, TerminalSessionRow>;
  audit: AuditRow[];
  failNextAudit(action: string): void;
  failNestedPoolQueries(): void;
  rooms: Record<string, string[]>;
  edges: string[];
  placements: Array<{ tenant_id: string; alias: string; container_name: string; runtime_user: string }>;
}

function isOpen(row: TerminalSessionRow, ttlSeconds: number, now: number): boolean {
  if (row.closed_at !== null || row.revoked_at !== null) return false;
  if (row.consumed_at === null) return row.expires_at.getTime() > now;
  return row.consumed_at.getTime() + ttlSeconds * 1_000 > now;
}

function fakeDatabase(): FakeDatabase {
  const sessions = new Map<string, TerminalSessionRow>();
  const audit: AuditRow[] = [];
  let failingAuditAction: string | undefined;
  let checkedOutClients = 0;
  let rejectNestedPoolQueries = false;
  const clock = { now: () => Date.now() };
  const state = {
    placements: ([
      ['Steven', 'argos', 'ctrl-infra', 'dev'], ['Steven', 'jarvis', 'claw', 'claw'],
      ['Steven', 'kant', 'ctrl-infra', 'dev'], ['Steven', 'socrates', 'ws-prizma', 'dev'],
      ['Steven', 'zeus', 'ws-zeus', 'dev'], ['Miguel', 'atlas', 'ws-humanizar', 'dev'],
      ['Miguel', 'iza', 'ws-humanizar', 'dev'], ['Miguel', 'janus', 'claw-miguel', 'claw'],
      ['Miguel', 'kratos', 'ws-humanizar', 'dev'], ['Pablo', 'dedalo', 'ws-pablo-dev', 'dev'],
      ['Pablo', 'midas', 'agv2-pablo-marcas-oc', 'claw'],
      ['Pablo', 'seneca', 'agv2-pablo-personal-oc', 'claw'], ['Pablo', 'vulcano', 'ws-pablo', 'dev'],
      ['Isa', 'salva', 'ws-isa', 'dev'], ['Jhon', 'hegel', 'agv2-jhon-hegel-oc', 'claw'],
    ] satisfies ReadonlyArray<readonly [string, string, string, string]>).map(
      ([tenant_id, alias, container_name, runtime_user]) => ({ tenant_id, alias, container_name, runtime_user })
    ),
    rooms: {
      'Steven:kant': ['grp.steven'],
      'Steven:jarvis': ['grp.steven'],
      'Steven:argos': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:atlas': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    } as Record<string, string[]>,
    edges: ['Steven->Miguel'] as string[]
  };

  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const now = clock.now();
    if (text.includes('clock_timestamp() AS database_now')) {
      return { rows: [{ database_now: new Date(now) }], rowCount: 1 };
    }
    if (text.includes('SELECT tenant_id,alias,container_name,runtime_user')) {
      return { rows: state.placements, rowCount: state.placements.length };
    }
    if (text.includes('INSERT INTO audit_events')) {
      const [tenantId, actorAlias, action, decision, , metadata] = values as [string, string, string, string, unknown, string];
      if (action === failingAuditAction) {
        failingAuditAction = undefined;
        throw new Error(`forced ${action} audit failure`);
      }
      audit.push({
        tenant_id: tenantId, actor_alias: actorAlias, action, decision,
        metadata: JSON.parse(metadata) as Record<string, unknown>
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('decision AS MATERIALIZED') && text.includes('INSERT INTO terminal_sessions')) {
      const [
        operatorId, container, ttlSeconds, maxSessions, id, attributed, subject, tenantId, alias,
        generation, imageId, runtimeUser, mode, ticketSha256, reason, cols, rows, traceId,
        issuedAt, expiresAt, requestId, requestSha256, browserOwnerSha256,
        relayInstanceId,
      ] = values as [
        string, string, number, number, string, boolean, string, string, string, string, string,
        string, 'shell' | 'harness', Buffer, string, number, number, string, string, string,
        string, Buffer, Buffer, string,
      ];
      const operatorOpen = [...sessions.values()].filter((row) =>
        row.operator_id === operatorId
          && (attributed || row.console_subject === subject)
          && isOpen(row, ttlSeconds, now)).length;
      if (operatorOpen >= maxSessions) {
        return { rows: [{ reason: 'session_limit', id: null }], rowCount: 1 };
      }
      const containerBusy = [...sessions.values()].some((row) =>
        row.container === container && isOpen(row, ttlSeconds, now));
      if (containerBusy) return { rows: [{ reason: 'container_busy', id: null }], rowCount: 1 };
      sessions.set(id, {
        id, request_id: requestId, request_sha256: Buffer.from(requestSha256),
        browser_owner_sha256: Buffer.from(browserOwnerSha256), browser_owner_generation: '1',
        operator_id: operatorId, attributed, console_subject: subject, tenant_id: tenantId,
        alias, container, generation, image_id: imageId, runtime_user: runtimeUser, mode,
        ticket_sha256: ticketSha256, reason, cols, rows, trace_id: traceId,
        issued_at: new Date(issuedAt), expires_at: new Date(expiresAt), consumed_at: null,
        relay_claim_sha256: null, relay_claim_epoch: '0', relay_claimed_at: null,
        relay_claim_expires_at: null,
        relay_instance_id: relayInstanceId, relay_boot_id: null,
        revoked_at: null, closed_at: null, close_reason: null, bytes_in: 0, bytes_out: 0,
      });
      return { rows: [{ reason: 'ok', id }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO terminal_sessions')) {
      const [
        id, operatorId, attributed, subject, tenantId, alias, container, generation, imageId,
        runtimeUser, mode, ticketSha256, reason, cols, rows, traceId, expiresAt
      ] = values as [
        string, string, boolean, string, string, string, string, string, string,
        string, 'shell' | 'harness', Buffer, string, number, number, string, string
      ];
      sessions.set(id, {
        id, request_id: id, request_sha256: Buffer.from(ticketSha256),
        browser_owner_sha256: Buffer.from(ticketSha256), browser_owner_generation: '1',
        operator_id: operatorId, attributed, console_subject: subject, tenant_id: tenantId,
        alias, container, generation, image_id: imageId, runtime_user: runtimeUser, mode,
        ticket_sha256: ticketSha256, reason, cols, rows, trace_id: traceId,
        issued_at: new Date(now), expires_at: new Date(expiresAt), consumed_at: null,
        relay_claim_sha256: null, relay_claim_epoch: '0', relay_claimed_at: null,
        relay_claim_expires_at: null,
        relay_instance_id: RELAY_A, relay_boot_id: null,
        revoked_at: null, closed_at: null, close_reason: null, bytes_in: 0, bytes_out: 0
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SELECT count(*)::int AS open FROM terminal_sessions')) {
      const open = [...sessions.values()].filter((row) => text.includes('WHERE operator_id=$1')
        ? row.operator_id === values[0] && isOpen(row, values[1] as number, now)
        : row.container === values[0] && row.operator_id !== values[1] && isOpen(row, values[2] as number, now));
      return { rows: [{ open: open.length }], rowCount: 1 };
    }
    if (text.includes('AS session_unexpired')) {
      const row = sessions.get(values[0] as string);
      if (!row) return { rows: [], rowCount: 0 };
      const expiry = row.consumed_at === null
        ? null : new Date(row.consumed_at.getTime() + (values[1] as number) * 1_000);
      if (text.includes('SELECT terminal_sessions.*')) {
        return {
          rows: [{
            ...row,
            database_now: new Date(now),
            session_expires_at: expiry,
            session_unexpired: expiry !== null && row.revoked_at === null && row.closed_at === null
              && expiry.getTime() > now,
          }],
          rowCount: 1,
        };
      }
      return {
        rows: [{
          consumed_at: row.consumed_at,
          revoked_at: row.revoked_at,
          closed_at: row.closed_at,
          session_expires_at: expiry,
          session_unexpired: expiry !== null && expiry.getTime() > now,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('AS ticket_redeemable') && text.includes('AS session_recoverable')) {
      const row = sessions.get(values[0] as string);
      if (!row) return { rows: [], rowCount: 0 };
      const ttlSeconds = values[1] as number;
      return {
        rows: [{
          ...row,
          ticket_redeemable: row.consumed_at === null && row.revoked_at === null
            && row.closed_at === null && row.expires_at.getTime() > now,
          session_recoverable: row.consumed_at !== null && row.revoked_at === null
            && row.closed_at === null
            && row.consumed_at.getTime() + ttlSeconds * 1_000 > now,
          database_now: new Date(now),
        }],
        rowCount: 1,
      };
    }
    if (text.includes('AS request_unexpired') && text.includes('WHERE request_id=$1')) {
      const row = [...sessions.values()].find((candidate) => candidate.request_id === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [{ ...row, request_unexpired: row.expires_at.getTime() > now }],
        rowCount: 1,
      };
    }
    if (text.includes('ORDER BY issued_at DESC') && text.includes('consumed_at IS NULL')
        && text.includes('FOR UPDATE') && text.includes('AND tenant_id=$4')) {
      const [operatorId, attributed, subject, tenantId, alias, container, mode, reason, cols, rows] = values as [
        string, boolean, string, string, string, string, 'shell' | 'harness', string, number, number,
      ];
      const candidates = [...sessions.values()].filter((row) =>
        row.operator_id === operatorId
        && (attributed || row.console_subject === subject)
        && row.tenant_id === tenantId && row.alias === alias && row.container === container
        && row.mode === mode && row.reason === reason && row.cols === cols && row.rows === rows
        && row.consumed_at === null && row.revoked_at === null && row.closed_at === null
        && row.expires_at.getTime() > now);
      candidates.sort((left, right) => right.issued_at.getTime() - left.issued_at.getTime());
      return { rows: candidates.slice(0, 1), rowCount: Math.min(1, candidates.length) };
    }
    if (text.includes('SELECT * FROM terminal_sessions WHERE id=$1')) {
      const row = sessions.get(values[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('FROM terminal_sessions') && text.includes('WHERE operator_id=$1')) {
      const rows = [...sessions.values()].filter((row) => row.operator_id === values[0]
        && ((values[2] as boolean) || row.console_subject === values[3]));
      rows.sort((left, right) => {
      if (text.includes('ORDER BY occupies_slot')) {
          const openOrder = Number(isOpen(right, values[1] as number, now))
            - Number(isOpen(left, values[1] as number, now));
          if (openOrder !== 0) return openOrder;
        }
        return right.issued_at.getTime() - left.issued_at.getTime();
      });
      if (text.includes('LIMIT 100')) rows.splice(100);
      const output = text.includes('AS occupies_slot')
        ? rows.map((row) => ({ ...row, occupies_slot: isOpen(row, values[1] as number, now) }))
        : rows;
      return { rows: output, rowCount: output.length };
    }
    if (text.includes('SET consumed_at=now(), relay_claim_sha256=$2')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.consumed_at !== null || row.revoked_at !== null || row.closed_at !== null
          || row.expires_at.getTime() <= now || row.relay_instance_id !== values[5]) {
        return { rows: [], rowCount: 0 };
      }
      row.consumed_at = new Date(now);
      row.relay_claim_sha256 = Buffer.from(values[1] as Buffer);
      row.relay_claim_epoch = '1';
      row.relay_claimed_at = new Date(now);
      row.relay_boot_id = values[4] as string;
      row.relay_claim_expires_at = new Date(now + Math.min(
        values[2] as number,
        values[3] as number,
      ) * 1_000);
      return { rows: [{ ...row, database_now: new Date(now) }], rowCount: 1 };
    }
    if (text.includes('SET relay_claim_expires_at=LEAST')) {
      const row = sessions.get(values[0] as string);
      const expectedDigest = values[1] as Buffer;
      const expectedEpoch = values[4] as string;
      const sessionTtlSeconds = values[3] as number;
      if (!row || row.relay_claim_sha256 === null || !row.relay_claim_sha256.equals(expectedDigest)
          || row.relay_claim_epoch !== expectedEpoch || row.relay_claim_expires_at === null
          || row.relay_claim_expires_at.getTime() <= now || row.consumed_at === null
          || row.revoked_at !== null || row.closed_at !== null
          || row.relay_instance_id !== values[5] || row.relay_boot_id !== values[6]
          || row.consumed_at.getTime() + sessionTtlSeconds * 1_000 <= now) {
        return { rows: [], rowCount: 0 };
      }
      const sessionExpiresAt = new Date(row.consumed_at.getTime() + sessionTtlSeconds * 1_000);
      row.relay_claim_expires_at = new Date(Math.min(
        sessionExpiresAt.getTime(),
        now + (values[2] as number) * 1_000,
      ));
      return {
        rows: [{ ...row, database_now: new Date(now), session_expires_at: sessionExpiresAt }],
        rowCount: 1,
      };
    }
    if (text.includes('SET relay_claim_sha256=$2')
        && text.includes('relay_claim_epoch=relay_claim_epoch+1')) {
      const row = sessions.get(values[0] as string);
      const sessionTtlSeconds = values[3] as number;
      if (!row || row.consumed_at === null || row.revoked_at !== null || row.closed_at !== null
          || row.consumed_at.getTime() + sessionTtlSeconds * 1_000 <= now
          || (row.relay_claim_expires_at !== null && row.relay_claim_expires_at.getTime() > now)
          || BigInt(row.relay_claim_epoch) >= 9_223_372_036_854_775_807n) {
        return { rows: [], rowCount: 0 };
      }
      row.relay_claim_sha256 = Buffer.from(values[1] as Buffer);
      row.relay_claim_epoch = (BigInt(row.relay_claim_epoch) + 1n).toString();
      row.relay_claimed_at = new Date(now);
      row.relay_instance_id = values[4] as string;
      row.relay_boot_id = values[5] as string;
      row.relay_claim_expires_at = new Date(Math.min(
        row.consumed_at.getTime() + sessionTtlSeconds * 1_000,
        now + (values[2] as number) * 1_000,
      ));
      return { rows: [{ ...row, database_now: new Date(now) }], rowCount: 1 };
    }
    if (text.includes('SET consumed_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.consumed_at !== null || row.revoked_at !== null || row.closed_at !== null
          || row.expires_at.getTime() <= now) {
        return { rows: [], rowCount: 0 };
      }
      row.consumed_at = new Date(now);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SET browser_owner_sha256=$4')) {
      const row = sessions.get(values[0] as string);
      const expectedGeneration = values[2] as string;
      if (!row || row.request_id !== values[1]
          || row.browser_owner_generation !== expectedGeneration
          || row.operator_id !== values[4]
          || (!(values[5] as boolean) && row.console_subject !== values[6])
          || row.revoked_at !== null || row.closed_at !== null
          || BigInt(row.browser_owner_generation) >= 9_223_372_036_854_775_807n) {
        return { rows: [], rowCount: 0 };
      }
      row.browser_owner_sha256 = Buffer.from(values[3] as Buffer);
      row.browser_owner_generation = (BigInt(row.browser_owner_generation) + 1n).toString();
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SET revoked_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.operator_id !== values[1]
          || (!(values[2] as boolean) && row.console_subject !== values[3])
          || row.request_id !== values[4]
          || row.browser_owner_generation !== values[5]
          || !row.browser_owner_sha256.equals(values[6] as Buffer)
          || row.revoked_at !== null || row.closed_at !== null) {
        return { rows: [], rowCount: 0 };
      }
      row.revoked_at = new Date(now);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('AS settled') && text.includes('browser_owner_sha256=$7')) {
      const row = sessions.get(values[0] as string);
      const settled = row !== undefined
        && row.operator_id === values[1]
        && ((values[2] as boolean) || row.console_subject === values[3])
        && row.request_id === values[4]
        && row.browser_owner_generation === values[5]
        && row.browser_owner_sha256.equals(values[6] as Buffer)
        && (row.revoked_at !== null || row.closed_at !== null);
      return { rows: [{ settled }], rowCount: 1 };
    }
    if (text.includes('SET closed_at=now()')) {
      const row = sessions.get(values[0] as string);
      if (!row || row.closed_at !== null) return { rows: [], rowCount: 0 };
      if (text.includes('relay_claim_sha256=$6')) {
        const legacy = values[4] as boolean;
        const exact = !legacy && row.relay_claim_sha256 !== null
          && (values[5] as Buffer | null) !== null
          && row.relay_claim_sha256.equals(values[5] as Buffer)
          && row.relay_claim_epoch === values[6];
        const legacyMatch = legacy && row.relay_claim_sha256 === null && row.relay_claim_epoch === '0';
        const exactRelay = row.relay_instance_id === values[7]
          && row.relay_boot_id === (values[8] ?? null);
        if ((!exact && !legacyMatch) || !exactRelay) return { rows: [], rowCount: 0 };
      }
      row.closed_at = new Date(now);
      row.close_reason = values[1] as string;
      row.bytes_in = values[2] as number;
      row.bytes_out = values[3] as number;
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SELECT agent.tenant_id,agent.alias,agent.harness_id')) {
      const [actorTenant, , targetTenant, targetAlias] = values as [string, string, string, string];
      const visible = actorTenant === targetTenant || state.edges.includes(`${actorTenant}->${targetTenant}`);
      const target = state.placements.find((row) =>
        row.tenant_id === targetTenant && row.alias === targetAlias);
      const rows = !visible || target === undefined ? [] : [{
        tenant_id: targetTenant,
        alias: targetAlias,
        harness_id: null,
        home_directory: null,
        enabled: true,
      }];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('acl_edges')) {
      const [from, to] = values as [string, string];
      const rows = state.edges.includes(`${from}->${to}`) ? [{ ok: true }] : [];
      return { rows, rowCount: rows.length };
    }
    const [actorTenant, actorAlias, targetTenant, targetAlias] = values as [string, string, string, string];
    const rows = [
      ...(state.rooms[`${actorTenant}:${actorAlias}`] ?? []).map((room_id) => ({ side: 'actor', room_id })),
      ...(state.rooms[`${targetTenant}:${targetAlias}`] ?? []).map((room_id) => ({ side: 'target', room_id }))
    ];
    return { rows, rowCount: rows.length };
  };

  const cloneRow = (row: TerminalSessionRow): TerminalSessionRow => ({
    ...row,
    ticket_sha256: Buffer.from(row.ticket_sha256),
    request_sha256: Buffer.from(row.request_sha256),
    browser_owner_sha256: Buffer.from(row.browser_owner_sha256),
    issued_at: new Date(row.issued_at),
    expires_at: new Date(row.expires_at),
    consumed_at: row.consumed_at === null ? null : new Date(row.consumed_at),
    relay_claim_sha256: row.relay_claim_sha256 === null ? null : Buffer.from(row.relay_claim_sha256),
    relay_claimed_at: row.relay_claimed_at === null ? null : new Date(row.relay_claimed_at),
    relay_claim_expires_at: row.relay_claim_expires_at === null
      ? null : new Date(row.relay_claim_expires_at),
    revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at),
    closed_at: row.closed_at === null ? null : new Date(row.closed_at),
  });
  return {
    pool: {
      query: async (text: string, values: unknown[] = []) => {
        if (rejectNestedPoolQueries && checkedOutClients > 0) {
          throw new Error('pool.query attempted while the only database client is checked out');
        }
        return query(text, values);
      },
      connect: async () => {
        checkedOutClients += 1;
        let snapshot: { sessions: Map<string, TerminalSessionRow>; auditLength: number } | undefined;
        let released = false;
        return {
          query: async (text: string, values: unknown[] = []) => {
            if (text === 'BEGIN') {
              snapshot = {
                sessions: new Map([...sessions].map(([id, row]) => [id, cloneRow(row)])),
                auditLength: audit.length,
              };
              return { rows: [], rowCount: null };
            }
            if (text === 'ROLLBACK') {
              if (snapshot !== undefined) {
                sessions.clear();
                for (const [id, row] of snapshot.sessions) sessions.set(id, row);
                audit.splice(snapshot.auditLength);
              }
              snapshot = undefined;
              return { rows: [], rowCount: null };
            }
            if (text === 'COMMIT') {
              snapshot = undefined;
              return { rows: [], rowCount: null };
            }
            return query(text, values);
          },
          release: () => {
            if (released) return;
            released = true;
            checkedOutClients -= 1;
          },
        };
      },
    } as unknown as DatabasePool,
    clock, sessions, audit,
    failNextAudit: (action) => { failingAuditAction = action; },
    failNestedPoolQueries: () => { rejectNestedPoolQueries = true; },
    rooms: state.rooms,
    edges: state.edges, placements: state.placements,
  };
}

/** The single console certificate in production: Steven:kant, operator, route+read+control. */
function consoleAuthProvider(overrides: Partial<Principal> = {}): AuthProvider {
  const actor: Principal = {
    tenant_id: 'Steven', alias: 'kant', session_id: 'console-session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'], ...overrides
  };
  return {
    name: 'test-console', mode: 'test',
    authenticateHttp: async () => actor,
    authenticateHello: async () => actor
  };
}

function presence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-7',
    image_id: 'sha256:c0ffee', runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw',
    modes: ['shell', 'harness'], connected_since: new Date().toISOString(),
    ...overrides
  };
}

describe('terminal control plane', () => {
  let directory: string;
  let grantsFile: string;
  let database: FakeDatabase;
  let registry: AgentRegistry;
  let app: FastifyInstance;
  let config: TerminalConfig;
  let controlPermission: () => Promise<void>;
  /** MEASURED facts per alias. Empty = nobody measured that container, which is today's state. */
  let hechos: Map<string, { facts: RuntimeFacts; source: FactsSource }>;
  /** Everything the gateway asked the terminal-relay, in order. */
  let pedidas: Array<{ tenant_id: string; alias: string; path: string }>;
  let leer: (path: string) => RelayFileRead | GovernanceReadError;
  let relayPeerInstanceId: string;
  let relayBootId: string;

  async function build(overrides: Partial<TerminalConfig> = {}, provider = consoleAuthProvider()): Promise<void> {
    // A test that rebuilds with another config must not leak the instance beforeEach created.
    if (app !== undefined) await app.close();
    config = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: MASTER,
      relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([RELAY_A, RELAY_B]),
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set<string>(),
      ...overrides
    };
    app = Fastify({ logger: false });
    // app.inject has no TLS socket. This test harness supplies the independently authenticated
    // peer identity and envelopes legacy test calls exactly as the real relay client does.
    app.addHook('preValidation', async (request) => {
      if (!request.url.startsWith('/v3/terminal/relay/')) return;
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return;
      const body = request.body as Record<string, unknown>;
      body.relay_instance_id ??= relayPeerInstanceId;
      body.relay_boot_id ??= relayBootId;
    });
    // Same hook app.ts installs before the plugin; it must cover the console routes and must
    // NOT cover the relay routes, which is exactly why those live outside /v3/console/.
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [ORIGIN] }));
    await app.register(registerTerminalControlPlane, {
      pool: database.pool,
      authProvider: provider,
      config,
      registry,
      repository: {
        assertPermission: async () => { await controlPermission(); },
        authorizeAgentTarget: async (actorTenant, _actorAlias, targetTenant, targetAlias) => {
          const visible = targetTenant === actorTenant || database.edges.includes(`${actorTenant}->${targetTenant}`);
          const target = database.placements.find((row) =>
            row.tenant_id === targetTenant && row.alias === targetAlias);
          return !visible || !target ? undefined : {
            tenant_id: targetTenant,
            alias: targetAlias,
            harness_id: null,
            home_directory: null,
            enabled: true,
          };
        },
      },
      measuredFacts: { factsFor: async (tenantId, alias) => hechos.get(`${tenantId}:${alias}`) },
      // The terminal-relay is the only thing substituted: mounting the whole relay here would
      // test the relay, not the plugin. What is recorded is WHICH routes get asked for, which
      // is the part the gateway decides.
      governanceRelay: {
        readFile: async (tenantId, alias, path) => {
          pedidas.push({ tenant_id: tenantId, alias, path });
          return leer(path);
        }
      },
      relayPeerInstanceId: () => relayPeerInstanceId,
    });
    await app.ready();
  }

  async function report(agents: readonly AgentPresence[]): Promise<void> {
    const response = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { agents }
    });
    expect(response.statusCode).toBe(200);
  }

  async function grant(entries: Array<{ operator?: string; tenant_id: string; alias: string; modes: string[] }>): Promise<void> {
    await writeFile(grantsFile, JSON.stringify({
      version: 1,
      grants: entries.map((entry) => ({ operator: entry.operator ?? '*', ...entry }))
    }));
  }

  async function openSession(
    body: Record<string, unknown>, headers: Record<string, string> = {}
  ): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
    return app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      headers: { origin: ORIGIN, ...headers },
      payload: {
        tenant_id: 'Steven', alias: 'jarvis', mode: 'shell',
        reason: 'revisar el harness colgado', cols: 120, rows: 40,
        request_id: randomUUID(), owner_token: randomUUID(), ...body
      }
    });
  }

  async function issueAndConsume(): Promise<{
    sessionId: string;
    ticket: string;
    resumeToken: string;
    sessionExpiresAt: string;
    claimToken: string;
    claimEpoch: string;
  }> {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const consumed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(consumed.statusCode).toBe(200);
    const grant = consumed.json<{
      resume_token: string;
      session_expires_at: string;
      claim_token: string;
      claim_epoch: string;
    }>();
    return {
      sessionId: issued.session_id,
      ticket: issued.ticket,
      resumeToken: grant.resume_token,
      sessionExpiresAt: grant.session_expires_at,
      claimToken: grant.claim_token,
      claimEpoch: grant.claim_epoch,
    };
  }

  async function resumeSession(
    sessionId: string,
    resumeToken: string,
    claimToken = CLAIM_A,
    claimEpoch: string | undefined = '1',
  ) {
    return app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${sessionId}/resume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        resume_token: resumeToken,
        claim_token: claimToken,
        ...(claimEpoch === undefined ? {} : { claim_epoch: claimEpoch }),
      },
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-'));
    grantsFile = join(directory, 'grants.json');
    database = fakeDatabase();
    registry = new AgentRegistry();
    controlPermission = async () => undefined;
    hechos = new Map();
    pedidas = [];
    leer = (path) => ({
      path, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z',
      sha: createHash('sha256').update('# Manual\n').digest('hex'), content: '# Manual\n'
    });
    relayPeerInstanceId = RELAY_A;
    relayBootId = RELAY_BOOT_A;
    await grant([{ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }]);
    await build();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('lists only control-visible aliases with an explicit PTY state and never leaks another tenant', async () => {
    await report([presence()]);
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      websocket_path: string;
      items: Array<Record<string, unknown>>;
    }>();
    expect(body.websocket_path).toBe('/v3/console/terminal/ws');
    // Steven plus the one ACL-visible tenant Miguel. Pablo/Isa/Jhon remain absent rather than
    // leaking their identities and shared-container cohorts as unauthorized rows.
    expect(body.items).toHaveLength(9);
    for (const item of body.items) {
      expect(['online', 'agent_offline', 'not_installed', 'unknown']).toContain(item.pty_state);
      expect(typeof item.reason).toBe('string');
      expect((item.reason as string).length).toBeGreaterThan(0);
    }
    const jarvis = body.items.find((item) => item.alias === 'jarvis');
    expect(jarvis).toMatchObject({
      pty_state: 'online', authorized: true, container: 'claw', runtime_user: 'claw',
      harness: 'openclaw', image: 'sha256:c0ffee', shares_container_with: [], modes: ['shell', 'harness']
    });
    const argos = body.items.find((item) => item.alias === 'argos');
    // argos shares ctrl-infra with kant and no agent was ever reported there.
    expect(argos).toMatchObject({
      pty_state: 'not_installed', authorized: false,
      shares_container_with: [{ tenant_id: 'Steven', alias: 'kant' }]
    });
    const iza = body.items.find((item) => item.alias === 'iza');
    // Miguel is visible through the test ACL; without operator attribution, opening is still
    // denied, but its cohort is legitimate read/control-visible metadata.
    expect(iza).toMatchObject({
      authorized: false, container: null, runtime_user: null, harness: null, image: null,
      reason: 'sin autoridad sobre Miguel:iza',
      shares_container_with: [
        { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' }
      ]
    });
    expect(body.items.some((item) => item.tenant_id === 'Pablo')).toBe(false);
    expect(body.items.some((item) => item.tenant_id === 'Isa')).toBe(false);
    expect(body.items.some((item) => item.tenant_id === 'Jhon')).toBe(false);
  });

  it('publishes a state-specific reason for every authorized PTY state', async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const jarvis = async (): Promise<Record<string, unknown>> => {
      const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
      expect(response.statusCode).toBe(200);
      const item = response.json<{ items: Array<Record<string, unknown>> }>().items.find(
        (candidate) => candidate.tenant_id === 'Steven' && candidate.alias === 'jarvis',
      );
      expect(item).toBeDefined();
      return item!;
    };
    const expectAuthorizedState = (
      item: Record<string, unknown>,
      state: 'online' | 'agent_offline' | 'not_installed' | 'unknown',
      reason: string,
    ): void => {
      expect(item).toMatchObject({ authorized: true, pty_state: state, reason });
      if (state !== 'online') expect(item.reason).not.toBe('ok');
    };

    try {
      expectAuthorizedState(
        await jarvis(),
        'unknown',
        'El estado del agente PTY es desconocido: el terminal-relay todavía no publicó un snapshot verificable.',
      );

      await report([]);
      expectAuthorizedState(
        await jarvis(),
        'not_installed',
        'El agente PTY figura como no instalado: el terminal-relay nunca registró este destino en claw.',
      );

      await report([presence()]);
      expectAuthorizedState(
        await jarvis(),
        'online',
        'El agente PTY está conectado al terminal-relay.',
      );

      clock.mockReturnValue(now + AGENT_STALE_AFTER_MS + 1);
      expectAuthorizedState(
        await jarvis(),
        'agent_offline',
        'El agente PTY figura fuera de línea: no está conectado al terminal-relay.',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('redacts an entire shared cohort when any colocated identity is not control-visible', async () => {
    database.placements.push({
      tenant_id: 'Pablo', alias: 'oculto', container_name: 'claw', runtime_user: 'dev',
    });
    await report([presence()]);
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(items.some((item) => item.alias === 'oculto' || item.tenant_id === 'Pablo')).toBe(false);
    expect(items.find((item) => item.tenant_id === 'Steven' && item.alias === 'jarvis')).toMatchObject({
      authorized: false,
      container: null,
      shares_container_with: [],
      reason: 'sin autoridad sobre Steven:jarvis',
    });
  });

  it('issues a verifiable ticket, records the operator reason and audits the allow', async () => {
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      session_id: string; ticket: string; websocket_path: string; ttl_seconds: number;
      target: Record<string, unknown>;
    }>();
    expect(body.ttl_seconds).toBe(30);
    expect(body.websocket_path).toBe(`/v3/console/terminal/relays/${RELAY_A}/ws`);
    expect(body.target).toEqual({
      tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
      mode: 'shell', shares_container_with: []
    });
    const payload = parseAndVerify(body.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    expect(payload).toMatchObject({
      v: 1, sid: body.session_id, op: UNATTRIBUTED_OPERATOR, sub: 'Steven:kant', mode: 'shell',
      tgt: { tenant: 'Steven', alias: 'jarvis', container: 'claw', generation: 'gen-7', uid: 1000, user: 'claw' }
    });
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant', decision: 'allow' });
    expect(allow?.metadata).toMatchObject({
      operator_id: UNATTRIBUTED_OPERATOR, attributed: false, target_alias: 'jarvis', container: 'claw',
      image_id: 'sha256:c0ffee', generation: 'gen-7', mode: 'shell',
      operator_reason: 'revisar el harness colgado', cols: 120, rows: 40
    });
    // Only the truncated digest of the ticket is ever persisted in the audit trail.
    expect(allow?.metadata.ticket_sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(allow?.metadata)).not.toContain(body.ticket);
  });

  it('reconstructs the exact issuance receipt after gateway restart and a lost 201', async () => {
    await report([presence()]);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const firstResponse = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json<{
      session_id: string; ticket: string; request_id: string; owner_generation: string;
      ttl_seconds: number;
    }>();
    expect(first).toMatchObject({
      request_id: requestId,
      owner_generation: '1',
      ttl_seconds: 30,
    });

    registry = new AgentRegistry();
    // A rollout can change the configured TTL between the lost response and its retry. The
    // recovered receipt must describe the historical ticket, not today's config.
    await build({ ticketTtlSeconds: 90 });
    await report([presence()]);
    const retriedResponse = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(retriedResponse.statusCode).toBe(201);
    expect(retriedResponse.json()).toMatchObject({
      session_id: first.session_id,
      ticket: first.ticket,
      receipt_recovered: true,
      request_id: requestId,
      owner_generation: '1',
      ttl_seconds: 30,
    });
    expect(database.sessions.size).toBe(1);
    expect(database.audit.filter((row) => row.action === 'terminal.session.request')).toEqual([
      expect.objectContaining({
        decision: 'allow', metadata: expect.objectContaining({ receipt_recovered: false }) as unknown,
      }),
      expect.objectContaining({
        decision: 'allow', metadata: expect.objectContaining({ receipt_recovered: true }) as unknown,
      }),
    ]);
  });

  it('never coalesces a new browser admission merely because every visible field is identical', async () => {
    await report([presence()]);
    const first = await openSession({});
    expect(first.statusCode).toBe(201);

    // A remount/reopen has a fresh request id even when the human entered the same reason and
    // dimensions. It must collide with the live container instead of adopting the first SID.
    const remount = await openSession({});
    expect(remount.statusCode).toBe(409);
    expect(remount.json()).toEqual({ error: 'conflict', reason: 'container_busy' });
    expect(database.sessions.size).toBe(1);
  });

  it('fails closed when a retry reuses request_id with another owner or altered semantics', async () => {
    await report([presence()]);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const first = await openSession({ request_id: requestId, owner_token: ownerToken });
    expect(first.statusCode).toBe(201);

    const otherOwner = await openSession({ request_id: requestId, owner_token: randomUUID() });
    expect(otherOwner.statusCode).toBe(409);
    expect(otherOwner.json()).toEqual({ error: 'conflict', reason: 'request_conflict' });

    const altered = await openSession({
      request_id: requestId,
      owner_token: ownerToken,
      reason: 'la misma solicitud con semantica alterada',
    });
    expect(altered.statusCode).toBe(409);
    expect(altered.json()).toEqual({ error: 'conflict', reason: 'request_conflict' });
    expect(database.sessions.size).toBe(1);
  });

  it('parses the exact admission shape and accepts the one-character AliasSchema boundary', async () => {
    await report([presence()]);
    const extra = await openSession({ unexpected: true });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: 'invalid_request' });
    expect(database.sessions.size).toBe(0);

    database.placements.push({
      tenant_id: 'Steven', alias: 'a', container_name: 'one-char', runtime_user: 'dev',
    });
    database.rooms['Steven:a'] = ['grp.steven'];
    await grant([{ tenant_id: 'Steven', alias: 'a', modes: ['shell'] }]);
    await report([presence({ alias: 'a', container_id: 'one-char', runtime_user: 'dev' })]);
    const boundary = await openSession({ alias: 'a' });
    expect(boundary.statusCode).toBe(201);
    expect(boundary.json()).toMatchObject({ target: { tenant_id: 'Steven', alias: 'a' } });
  });

  it('rolls issuance back when its audit insert fails and admits the retry cleanly', async () => {
    await report([presence()]);
    database.failNextAudit('terminal.session.request');

    const failed = await openSession({});
    expect(failed.statusCode).toBe(400);
    expect(database.sessions.size).toBe(0);
    expect(database.audit).toHaveLength(0);

    const retried = await openSession({});
    expect(retried.statusCode).toBe(201);
    expect(database.sessions.size).toBe(1);
  });

  it('makes hidden and absent POST targets indistinguishable without hidden cohort audit metadata', async () => {
    await report([presence()]);
    const hidden = await openSession({ tenant_id: 'Pablo', alias: 'dedalo' });
    const absent = await openSession({ tenant_id: 'Pablo', alias: 'no-existe' });
    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not_found' });
    expect(absent.json()).toEqual(hidden.json());
    for (const row of database.audit.slice(-2)) {
      expect(row.metadata).toMatchObject({ container: null, cohort: [], reason: 'target_unavailable' });
      expect(JSON.stringify(row.metadata)).not.toContain('ws-pablo');
      expect(JSON.stringify(row.metadata)).not.toContain('vulcano');
    }

    database.placements.push({
      tenant_id: 'Pablo', alias: 'oculto', container_name: 'claw', runtime_user: 'dev',
    });
    const hiddenCohort = await openSession({});
    expect(hiddenCohort.statusCode).toBe(404);
    expect(hiddenCohort.json()).toEqual({ error: 'not_found' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({
      container: null, cohort: [], reason: 'target_unavailable',
    });
    expect(JSON.stringify(database.audit.at(-1)?.metadata)).not.toContain('oculto');
  });

  it.each([
    { clockOffsetMs: -5_001, accepted: false },
    { clockOffsetMs: -5_000, accepted: true },
    { clockOffsetMs: 5_000, accepted: true },
    { clockOffsetMs: 5_001, accepted: false },
  ])(
    'applies the inclusive PostgreSQL clock boundary at $clockOffsetMs ms',
    async ({ clockOffsetMs, accepted }) => {
      await build({ ticketTtlSeconds: 3, sessionTtlSeconds: 3 });
      const gatewayNow = 1_800_000_000_000;
      const databaseNow = gatewayNow + clockOffsetMs;
      const localClock = vi.spyOn(Date, 'now').mockReturnValue(gatewayNow);
      try {
        database.clock.now = () => databaseNow;
        await report([presence()]);

        const opened = await openSession({});
        expect(opened.statusCode).toBe(accepted ? 201 : 503);
        if (!accepted) {
          expect(database.sessions.size).toBe(0);
          return;
        }
        const issued = opened.json<{ session_id: string; ticket: string; expires_at: string }>();
        const row = database.sessions.get(issued.session_id);
        expect(row?.issued_at.getTime()).toBe(databaseNow);
        expect(row?.expires_at.getTime()).toBe(databaseNow + 3_000);
        expect(issued.expires_at).toBe(new Date(databaseNow + 3_000).toISOString());
        expect(verifyTicketSignature(
          issued.ticket,
          deriveAliasKey(MASTER, 'Steven', 'jarvis'),
        )).toMatchObject({
          iat: Math.floor(databaseNow / 1_000),
          exp: Math.floor((databaseNow + 3_000) / 1_000),
        });
      } finally {
        localClock.mockRestore();
      }
    }
  );

  it('fails closed before insertion when PostgreSQL and the gateway exceed agent clock tolerance', async () => {
    database.clock.now = () => Date.now() + 60_000;
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'terminal_clock_skew',
      message: 'terminal issuance is unavailable until gateway and PostgreSQL clocks agree',
    });
    expect(database.sessions.size).toBe(0);
  });

  it('expires live authorization with the PostgreSQL clock, not the gateway wall clock', async () => {
    const databaseNow = Date.now();
    database.clock.now = () => databaseNow;
    const consumed = await issueAndConsume();
    database.clock.now = () => databaseNow + config.sessionTtlSeconds * 1_000 + 1;
    const response = await app.inject({
      method: 'POST',
      url: `/v3/terminal/relay/sessions/${consumed.sessionId}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, reason: 'session_expired' });
  });

  it('refuses a reason shorter than eight characters', async () => {
    await report([presence()]);
    const response = await openSession({ reason: 'corto' });
    expect(response.statusCode).toBe(400);
    expect(database.audit).toHaveLength(0);
  });

  it('uses the tenant-qualified enabled registry and never resolves a bare alias across tenants', async () => {
    await report([presence()]);
    database.placements.push({
      tenant_id: 'Miguel', alias: 'jarvis', container_name: 'other-container', runtime_user: 'dev',
    });
    const wrongTenant = await openSession({ tenant_id: 'Miguel', alias: 'jarvis' });
    expect(wrongTenant.statusCode).toBe(403);
    expect(wrongTenant.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });

    const index = database.placements.findIndex((item) =>
      item.tenant_id === 'Steven' && item.alias === 'jarvis');
    expect(index).toBeGreaterThanOrEqual(0);
    database.placements.splice(index, 1); // models enabled=false because the SQL excludes it
    const disabled = await openSession({ tenant_id: 'Steven', alias: 'jarvis' });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.json()).toEqual({ error: 'not_found' });
  });

  it('HARD INVARIANT: an unattributed operator cannot reach another tenant, and the deny is audited', async () => {
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({ tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev' })]);
    const response = await openSession({ tenant_id: 'Miguel', alias: 'iza' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'attribution_required' });
    expect(database.audit).toEqual([expect.objectContaining({
      action: 'terminal.session.request', decision: 'deny',
      metadata: expect.objectContaining({ reason: 'attribution_required', target_alias: 'iza' }) as unknown
    })]);
  });

  it('accepts a cross-tenant target once the console names an enrolled human operator', async () => {
    await build({ operators: new Set(['steven']) });
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({ tenant_id: 'Miguel', alias, modes: ['shell'] })));
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{ target: Record<string, unknown> }>();
    // The dialog must be able to say out loud who else lives in that container.
    expect(body.target.shares_container_with).toEqual([
      { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' }
    ]);
    const allow = database.audit.find((row) => row.action === 'terminal.session.request');
    expect(allow?.metadata).toMatchObject({
      operator_id: 'steven', attributed: true,
      cohort: ['Miguel:atlas', 'Miguel:iza', 'Miguel:kratos']
    });
  });

  it('SET RULE: a grant on iza alone does not open the container shared with atlas and kratos', async () => {
    await build({ operators: new Set(['steven']) });
    await grant([{ tenant_id: 'Miguel', alias: 'iza', modes: ['shell'] }]);
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev', modes: ['shell']
    })]);
    const response = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' }
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    expect(database.audit.at(-1)?.decision).toBe('deny');
  });

  it('denies every target when grants.json is missing, without restarting anything', async () => {
    await rm(grantsFile);
    await report([presence()]);
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'no_grant' });
    const targets = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    expect(targets.json<{ items: Array<{ authorized: boolean }> }>().items.every((item) => !item.authorized)).toBe(true);
  });

  it('refuses a target with no live pty-agent and reports why', async () => {
    const response = await openSession({});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'agent_offline' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({ reason: 'agent_offline', pty_state: 'unknown' });
  });

  it('fails closed when two authenticated relay instances advertise the same alias', async () => {
    await report([presence()]);
    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    await report([presence({ generation: 'gen-from-b' })]);

    const response = await openSession({});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'agent_offline' });
    expect(database.audit.at(-1)?.metadata).toMatchObject({
      reason: 'agent_offline',
      routing_state: 'relay_ambiguous',
    });
    expect(database.sessions.size).toBe(0);
  });

  it('rejects a concurrent boot sharing one fresh certificate identity', async () => {
    await report([presence()]);
    relayBootId = RELAY_BOOT_B;
    const response = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { agents: [presence()] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, reason: 'relay_boot_conflict' });
    expect(registry.accepts({ relay_instance_id: RELAY_A, relay_boot_id: RELAY_BOOT_A })).toBe(true);
  });

  it('refuses when the database has withdrawn the control permission', async () => {
    await report([presence()]);
    controlPermission = () => Promise.reject(new Error('principal lacks control permission'));
    const response = await openSession({});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('revocar y robar un terminal tambien pasan por la puerta de la BD, no solo por la sesion', async () => {
    // Medido el 2026-08-30 contra produccion: con un principal cuya membresia NO tenia
    // `allow_control`, estas dos rutas devolvian 409 `stale_terminal_owner` sobre UUID inventados,
    // nunca 403. `requireOperatorPermission` mira la SESION y pasaba; la comprobacion contra la BD
    // que si hace `POST /terminal/sessions` no estaba. El CAS frenaba la toma real —hace falta el
    // owner_token—, pero la puerta faltaba y las dos capas de autorizacion no coincidian.
    await report([presence()]);
    const abierta = (await openSession({})).json<{ session_id: string }>();
    controlPermission = () => Promise.reject(new Error('principal lacks control permission'));

    const robo = await app.inject({
      method: 'POST', url: `/v3/console/terminal/sessions/${abierta.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: { expected_owner_generation: 1, owner_token: 'x'.repeat(43), request_id: randomUUID() },
    });
    expect(robo.statusCode).toBe(403);
    expect(robo.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });

    const revocacion = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${abierta.session_id}`,
      headers: { origin: ORIGIN },
      payload: { owner_generation: 1, owner_token: 'x'.repeat(43), request_id: randomUUID() },
    });
    expect(revocacion.statusCode).toBe(403);
    expect(revocacion.json()).toEqual({ error: 'forbidden', reason: 'control_permission_required' });
  });

  it('caps concurrent sessions per operator', async () => {
    await build({ maxSessionsPerOperator: 1 });
    await report([presence()]);
    expect((await openSession({})).statusCode).toBe(201);
    const second = await openSession({ reason: 'una segunda tarea diferente' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'conflict', reason: 'session_limit' });
  });

  it('rejects a relay call without the shared token and says nothing about why', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: RELAY_TOKEN }]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/terminal/relay/agents', headers, payload: { agents: [] }
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe('');
    }
  });

  it('recovers an exact consume receipt after a lost 200 without mutating twice', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const consume = async (): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> =>
      app.inject({
        method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        payload: { ticket: issued.ticket, claim_token: CLAIM_A }
      });
    const first = await consume();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true, tenant_id: 'Steven', alias: 'jarvis', mode: 'shell', cols: 120, rows: 40,
      operator_id: UNATTRIBUTED_OPERATOR, container: 'claw', runtime_user: 'claw'
    });
    const consumed = first.json<{ expires_at: string; session_expires_at: string }>();
    expect(Date.parse(consumed.session_expires_at) - Date.parse(consumed.expires_at))
      .toBeGreaterThan((config.sessionTtlSeconds - config.ticketTtlSeconds - 5) * 1_000);
    const replay = await consume();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, receipt_recovered: true });
    expect(replay.json<{ resume_token: string }>().resume_token).not.toBe(
      first.json<{ resume_token: string }>().resume_token,
    );
    expect(database.audit.filter((row) => row.action === 'terminal.session.consume')).toEqual([
      expect.objectContaining({
        decision: 'info', metadata: expect.objectContaining({ receipt_recovered: false }) as unknown,
      }),
      expect.objectContaining({
        decision: 'info', metadata: expect.objectContaining({ receipt_recovered: true }) as unknown,
      }),
    ]);
  });

  it('reuses one checked-out client for consume, resume and authz policy reads', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    database.failNestedPoolQueries();
    const consumed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(consumed.statusCode).toBe(200);
    const grant = consumed.json<{ resume_token: string; claim_epoch: string }>();

    const resumed = await resumeSession(issued.session_id, grant.resume_token, CLAIM_A, grant.claim_epoch);
    expect(resumed.statusCode).toBe(200);
    const authz = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { claim_token: CLAIM_A, claim_epoch: grant.claim_epoch },
    });
    expect(authz.statusCode).toBe(200);
  });

  it('rotates relay instance and boot only after the PostgreSQL lease expires', async () => {
    const consumed = await issueAndConsume();
    const issuedRow = database.sessions.get(consumed.sessionId)!;
    expect(issuedRow.relay_instance_id).toBe(RELAY_A);
    expect(issuedRow.relay_boot_id).toBe(RELAY_BOOT_A);

    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    await report([presence()]);
    const stillLeased = await resumeSession(
      consumed.sessionId, consumed.resumeToken, CLAIM_B, consumed.claimEpoch,
    );
    expect(stillLeased.statusCode).toBe(409);
    expect(stillLeased.json()).toMatchObject({ ok: false, reason: 'claim_conflict' });

    const afterLease = issuedRow.relay_claim_expires_at!.getTime() + 1;
    database.clock.now = () => afterLease;
    const takeover = await resumeSession(
      consumed.sessionId, consumed.resumeToken, CLAIM_B, consumed.claimEpoch,
    );
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({
      ok: true,
      claim_epoch: '2',
      claim_taken_over: true,
      relay_instance_id: RELAY_B,
      relay_boot_id: RELAY_BOOT_B,
    });
    expect(database.sessions.get(consumed.sessionId)).toMatchObject({
      relay_instance_id: RELAY_B,
      relay_boot_id: RELAY_BOOT_B,
      relay_claim_epoch: '2',
    });

    relayPeerInstanceId = RELAY_A;
    relayBootId = RELAY_BOOT_A;
    const fenced = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${consumed.sessionId}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch },
    });
    expect(fenced.statusCode).toBe(403);
    expect(fenced.json()).toEqual({ ok: false, reason: 'claim_fenced' });

    const staleClose = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${consumed.sessionId}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'stale a', exit_code: null, bytes_in: 1, bytes_out: 1,
        claim_token: consumed.claimToken, claim_epoch: consumed.claimEpoch,
      },
    });
    expect(staleClose.statusCode).toBe(200);
    expect(database.sessions.get(consumed.sessionId)?.closed_at).toBeNull();

    relayPeerInstanceId = RELAY_B;
    relayBootId = RELAY_BOOT_B;
    const exactClose = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${consumed.sessionId}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'winner b', exit_code: 0, bytes_in: 2, bytes_out: 3,
        claim_token: CLAIM_B, claim_epoch: '2',
      },
    });
    expect(exactClose.statusCode).toBe(200);
    expect(database.sessions.get(consumed.sessionId)?.closed_at).not.toBeNull();
  });

  it('rejects a ticket signed with another alias key', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const payload = parseAndVerify(issued.ticket, deriveAliasKey(MASTER, 'Steven', 'jarvis'));
    const { issueTicket } = await import('./terminal/tickets.js');
    const forged = issueTicket(payload, deriveAliasKey(MASTER, 'Steven', 'argos'));
    const response = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: forged, claim_token: CLAIM_A }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, reason: 'ticket_invalid' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('rejects non-canonical claim capabilities before touching terminal lifecycle state', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    for (const claimToken of [
      'abcdefab-cdef-4def-8def-abcdefabcdef'.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const response = await app.inject({
        method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        payload: { ticket: issued.ticket, claim_token: claimToken },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, reason: 'ticket_invalid' });
    }
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('rolls consume back when audit fails and recovers on the exact ticket retry', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    database.failNextAudit('terminal.session.consume');

    const failed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(failed.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
    expect(database.audit.some((row) => row.action === 'terminal.session.consume')).toBe(false);

    const retried = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, receipt_recovered: false });
  });

  it('revalidates grants immediately before consume with no authz-loop window', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await grant([]);

    const refused = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ ok: false, reason: 'no_grant' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
    expect(database.audit.at(-1)).toMatchObject({
      action: 'terminal.session.consume', decision: 'deny',
      metadata: expect.objectContaining({ reason: 'no_grant' }) as unknown,
    });
  });

  it('revalidates canonical cross-tenant ACL and current cohort before consume', async () => {
    await build({ operators: new Set(['steven']) });
    await grant(['iza', 'atlas', 'kratos'].map((alias) => ({
      tenant_id: 'Miguel', alias, modes: ['shell'],
    })));
    await report([presence({
      tenant_id: 'Miguel', alias: 'iza', container_id: 'ws-humanizar', runtime_user: 'dev',
      modes: ['shell'],
    })]);
    const issuedResponse = await openSession(
      { tenant_id: 'Miguel', alias: 'iza' }, { 'x-cauce-operator': 'steven' },
    );
    expect(issuedResponse.statusCode).toBe(201);
    const issued = issuedResponse.json<{ session_id: string; ticket: string }>();
    database.edges.splice(0);

    const refused = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ ok: false, reason: 'control_authority_revoked' });
    expect(database.sessions.get(issued.session_id)?.consumed_at).toBeNull();
  });

  it('never consumes a ticket whose session was closed before its closed-aware CAS', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    const row = database.sessions.get(issued.session_id);
    expect(row).toBeDefined();
    if (row === undefined) return;
    row.closed_at = new Date();

    const refused = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(refused.statusCode).toBe(401);
    expect(row.consumed_at).toBeNull();
  });

  it('resume binds signature, sid, operator and the exact consumed-session TTL', async () => {
    const consumed = await issueAndConsume();
    const resumed = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      ok: true, tenant_id: 'Steven', alias: 'jarvis', operator_id: UNATTRIBUTED_OPERATOR,
      resume_token: consumed.resumeToken,
    });
    expect(database.audit.at(-1)).toMatchObject({ action: 'terminal.session.resume', decision: 'info' });

    const otherSid = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
    expect((await resumeSession(otherSid, consumed.resumeToken)).statusCode).toBe(401);

    const expiry = Math.floor(Date.parse(consumed.sessionExpiresAt) / 1_000);
    const wrongOperator = issueResumeToken(
      consumed.sessionId, 'another-operator', expiry, MASTER, Math.floor(Date.now() / 1_000),
    );
    expect((await resumeSession(consumed.sessionId, wrongOperator)).statusCode).toBe(401);

    const wrongTtl = issueResumeToken(
      consumed.sessionId, UNATTRIBUTED_OPERATOR, expiry + 1, MASTER, Math.floor(Date.now() / 1_000),
    );
    expect((await resumeSession(consumed.sessionId, wrongTtl)).statusCode).toBe(401);

    const tampered = `${consumed.resumeToken.slice(0, -1)}${consumed.resumeToken.endsWith('A') ? 'B' : 'A'}`;
    expect((await resumeSession(consumed.sessionId, tampered)).statusCode).toBe(401);
    const expired = issueResumeToken(
      consumed.sessionId, UNATTRIBUTED_OPERATOR, Math.floor(Date.now() / 1_000) - 1,
      MASTER, Math.floor(Date.now() / 1_000) - 10,
    );
    expect((await resumeSession(consumed.sessionId, expired)).statusCode).toBe(401);
  });

  it('resume revalidates revoked, closed, routing authority and grants on every call', async () => {
    const consumed = await issueAndConsume();
    const row = database.sessions.get(consumed.sessionId)!;

    row.revoked_at = new Date();
    expect((await resumeSession(consumed.sessionId, consumed.resumeToken)).json())
      .toEqual({ ok: false, reason: 'revoked' });
    row.revoked_at = null;

    row.closed_at = new Date();
    expect((await resumeSession(consumed.sessionId, consumed.resumeToken)).json())
      .toEqual({ ok: false, reason: 'closed' });
    row.closed_at = null;

    database.rooms['Steven:kant'] = [];
    const noAuthority = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(noAuthority.statusCode).toBe(403);
    expect(noAuthority.json()).toEqual({ ok: false, reason: 'no_routing_authority' });
    database.rooms['Steven:kant'] = ['grp.steven'];

    await grant([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const noGrant = await resumeSession(consumed.sessionId, consumed.resumeToken);
    expect(noGrant.statusCode).toBe(403);
    expect(noGrant.json()).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('revalidates a live session and cuts it as soon as grants.json is emptied', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A }
    });
    const authz = async (): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> =>
      app.inject({
        method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        payload: { claim_token: CLAIM_A, claim_epoch: '1' },
      });
    expect((await authz()).statusCode).toBe(200);
    await grant([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const cut = await authz();
    expect(cut.statusCode).toBe(403);
    expect(cut.json()).toEqual({ ok: false, reason: 'no_grant' });
    expect(database.audit.at(-1)).toMatchObject({
      action: 'terminal.session.revoked',
      metadata: expect.objectContaining({ reason: 'no_grant' }) as unknown
    });
  });

  it('lets the operator revoke a session and stops answering authz for it', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const revoked = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_token: ownerToken,
        owner_generation: issued.owner_generation,
      },
    });
    expect(revoked.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
    const authz = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { claim_token: CLAIM_A, claim_epoch: '1' },
    });
    expect(authz.json()).toEqual({ ok: false, reason: 'not_consumed' });
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json<{ items: Array<{ state: string }> }>().items).toEqual([
      expect.objectContaining({ alias: 'jarvis', mode: 'shell', state: 'closed' })
    ]);
  });

  it('fences a delayed DELETE after explicit takeover and makes the winning DELETE idempotent', async () => {
    await report([presence()]);
    const oldOwnerToken = randomUUID();
    const issued = (await openSession({ owner_token: oldOwnerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const newOwnerToken = randomUUID();

    const rotated = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: newOwnerToken,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      session_id: issued.session_id,
      request_id: issued.request_id,
      owner_generation: '2',
    });
    expect(rotated.body).not.toContain(newOwnerToken);

    const staleDelete = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: issued.owner_generation,
        owner_token: oldOwnerToken,
      },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();

    const winningPayload = {
      request_id: issued.request_id,
      owner_generation: '2',
      owner_token: newOwnerToken,
    };
    const winningDelete = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: winningPayload,
    });
    expect(winningDelete.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();

    const lost204Retry = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: winningPayload,
    });
    expect(lost204Retry.statusCode).toBe(204);
    expect(database.audit.filter((row) => row.action === 'terminal.session.revoked')).toHaveLength(1);
    expect(database.audit.filter((row) => row.action === 'terminal.session.owner_rotated')).toHaveLength(1);
  });

  it('reuses the checked-out transaction client for owner and DELETE audit cohort reads', async () => {
    await report([presence()]);
    const firstOwner = randomUUID();
    const issued = (await openSession({ owner_token: firstOwner })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const nextOwner = randomUUID();
    database.failNestedPoolQueries();

    const takeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: nextOwner,
      },
    });
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({ owner_generation: '2' });

    const released = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: '2',
        owner_token: nextOwner,
      },
    });
    expect(released.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
  });

  it('rejects extra ownership and DELETE fields before lifecycle mutation', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const rotate = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        expected_owner_generation: issued.owner_generation,
        owner_token: randomUUID(),
        extra: true,
      },
    });
    expect(rotate.statusCode).toBe(400);

    const release = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: issued.owner_generation,
        owner_token: ownerToken,
        extra: true,
      },
    });
    expect(release.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();
  });

  it('rolls owner rotation and revocation back with their audit row', async () => {
    await report([presence()]);
    const ownerToken = randomUUID();
    const issued = (await openSession({ owner_token: ownerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const nextOwnerToken = randomUUID();
    const ownerPayload = {
      request_id: issued.request_id,
      expected_owner_generation: issued.owner_generation,
      owner_token: nextOwnerToken,
    };

    database.failNextAudit('terminal.session.owner_rotated');
    const failedTakeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: ownerPayload,
    });
    expect(failedTakeover.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.browser_owner_generation).toBe('1');
    expect(database.audit.some((row) => row.action === 'terminal.session.owner_rotated')).toBe(false);

    const takeover = await app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${issued.session_id}/owner`,
      headers: { origin: ORIGIN },
      payload: ownerPayload,
    });
    expect(takeover.statusCode).toBe(200);

    const releasePayload = {
      request_id: issued.request_id,
      owner_generation: '2',
      owner_token: nextOwnerToken,
    };
    database.failNextAudit('terminal.session.revoked');
    const failedRelease = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: releasePayload,
    });
    expect(failedRelease.statusCode).toBe(400);
    expect(database.sessions.get(issued.session_id)?.revoked_at).toBeNull();
    expect(database.audit.some((row) => row.action === 'terminal.session.revoked')).toBe(false);

    const release = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: releasePayload,
    });
    expect(release.statusCode).toBe(204);
    expect(database.sessions.get(issued.session_id)?.revoked_at).not.toBeNull();
    expect(database.audit.filter((row) => row.action === 'terminal.session.revoked')).toHaveLength(1);
  });

  it('scopes unattributed quotas, listing and revocation to the authenticated console subject', async () => {
    await build({ maxSessionsPerOperator: 1 }, consoleAuthProvider({ alias: 'kant' }));
    await report([presence()]);
    const firstOwnerToken = randomUUID();
    const first = (await openSession({ owner_token: firstOwnerToken })).json<{
      session_id: string; request_id: string; owner_generation: string;
    }>();
    const firstRow = database.sessions.get(first.session_id);
    expect(firstRow).toBeDefined();
    if (firstRow === undefined) return;
    // Keep it open for quota purposes but move the synthetic row away from jarvis' container so
    // this unit test isolates the per-subject operator scope from the global container lock.
    firstRow.container = 'detached-test-container';

    database.rooms['Steven:socrates'] = ['grp.steven'];
    await build({ maxSessionsPerOperator: 1 }, consoleAuthProvider({ alias: 'socrates' }));
    const hidden = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ items: [] });

    const forbiddenRevoke = await app.inject({
      method: 'DELETE', url: `/v3/console/terminal/sessions/${first.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: first.request_id,
        owner_token: firstOwnerToken,
        owner_generation: first.owner_generation,
      },
    });
    expect(forbiddenRevoke.statusCode).toBe(409);
    expect(forbiddenRevoke.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
    expect(database.sessions.get(first.session_id)?.revoked_at).toBeNull();

    const independent = await openSession({ reason: 'tarea del segundo sujeto de consola' });
    expect(independent.statusCode).toBe(201);
    expect(database.sessions.size).toBe(2);
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json<{ items: Array<{ session_id: string }> }>().items).toEqual([
      expect.objectContaining({ session_id: independent.json<{ session_id: string }>().session_id }),
    ]);
  });

  it('never lets bounded history hide an older session that still consumes an operator slot', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string }>();
    const active = database.sessions.get(issued.session_id);
    expect(active).toBeDefined();
    if (!active) return;

    // More than the endpoint limit, all newer but already closed. An issued_at-only LIMIT 100
    // drops the one row the operator needs in order to escape session_limit.
    for (let index = 0; index < 110; index += 1) {
      database.sessions.set(`closed-history-${String(index).padStart(3, '0')}`, {
        ...active,
        id: `closed-history-${String(index).padStart(3, '0')}`,
        issued_at: new Date(active.issued_at.getTime() + index + 1),
        revoked_at: null,
        closed_at: new Date(active.issued_at.getTime() + index + 1),
        close_reason: 'test_history',
      });
    }

    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    const items = listed.json<{ items: Array<{ session_id: string; state: string }> }>().items;
    expect(items).toHaveLength(100);
    expect(items[0]).toMatchObject({ session_id: issued.session_id, state: 'issued' });
  });

  it('marks expiration with the database clock so the browser never decides whether a slot exists', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string }>();
    const row = database.sessions.get(issued.session_id);
    expect(row).toBeDefined();
    if (!row) return;
    row.expires_at = new Date(Date.now() - 1_000);

    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });

    expect(listed.json<{ items: Array<{ session_id: string; state: string }> }>().items).toEqual([
      expect.objectContaining({ session_id: issued.session_id, state: 'closed' }),
    ]);
  });

  it('records the close with its byte counters and reason', async () => {
    await report([presence()]);
    const issued = (await openSession({})).json<{ session_id: string; ticket: string }>();
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A }
    });
    const closed = await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
        claim_token: CLAIM_A, claim_epoch: '1',
      }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({
      ok: true,
      relay_instance_id: RELAY_A,
      relay_boot_id: RELAY_BOOT_A,
    });
    const close = database.audit.find((row) => row.action === 'terminal.session.close');
    expect(close?.metadata).toMatchObject({
      close_reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
      image_id: 'sha256:c0ffee', generation: 'gen-7', operator_reason: 'revisar el harness colgado'
    });
    // Closing twice must not duplicate the audit row.
    await app.inject({
      method: 'POST', url: `/v3/terminal/relay/sessions/${issued.session_id}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'again', exit_code: null, bytes_in: 0, bytes_out: 0,
        claim_token: CLAIM_A, claim_epoch: '1',
      }
    });
    expect(database.audit.filter((row) => row.action === 'terminal.session.close')).toHaveLength(1);
  });

  it('keeps the console security hook over the browser routes and off the relay routes', async () => {
    await report([presence()]);
    // A cross-origin POST from a browser is rejected before the plugin sees it.
    const crossOrigin = await openSession({}, { origin: 'https://evil.example' });
    expect(crossOrigin.statusCode).toBe(403);
    // The relay is not a browser and sends no Origin; its routes live outside /v3/console/.
    const relay = await app.inject({
      method: 'POST', url: '/v3/terminal/relay/agents',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload: { agents: [] }
    });
    expect(relay.statusCode).toBe(200);
  });

  /* ------------------------------------------------------------------ */
  /* GET /v3/console/agents/:tenant/:alias/directive                     */
  /* ------------------------------------------------------------------ */

  const CLAUDE = { facts: { harness: 'claude', home: '/home/dev' } as RuntimeFacts, source: 'measured' as FactsSource };
  const DIRECTIVA = '/v3/console/agents/Steven/jarvis/directive';
  const MANUAL = '/home/dev/.claude/CLAUDE.md';

  it('sirve el manual del sitio que el pty-agent devolvió', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<AgentDirective>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({
      text: '# Manual\n', bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z'
    });
  });

  it('sirve directiva a un reader sin abrir targets ni sesiones PTY', async () => {
    await build({}, consoleAuthProvider({ roles: [], permissions: ['read'] }));
    hechos.set('Steven:jarvis', CLAUDE);

    const directive = await app.inject({ method: 'GET', url: DIRECTIVA });
    const targets = await app.inject({ method: 'GET', url: '/v3/console/terminal/targets' });
    const session = await openSession({});

    expect(directive.statusCode).toBe(200);
    expect(directive.json<AgentDirective>().files).toEqual([
      expect.objectContaining({ path: MANUAL, text: '# Manual\n' }),
    ]);
    expect(targets.statusCode).toBe(403);
    expect(session.statusCode).toBe(403);
    expect(database.sessions.size).toBe(0);
  });

  it('sólo le pide al relay el manual del sitio, nunca settings.json ni .claude.json', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

//    Directive publishes manuals, not configuration inventory or memory. The other resources
//    have their own endpoints and must not appear even as empty rows.
    const files = response.json<AgentDirective>().files ?? [];
    expect(files.map((file) => file.path)).toEqual([MANUAL]);
    expect(files.filter((file) => file.text !== null).map((file) => file.path)).toEqual([MANUAL]);
//    The request to the relay stays just as closed: only the authorized manual.
    expect(pedidas).toEqual([{ tenant_id: 'Steven', alias: 'jarvis', path: MANUAL }]);
  });

  it('marca el fichero como no disponible cuando la lectura falla, sin inventar texto', async () => {
    hechos.set('Steven:jarvis', CLAUDE);
    leer = () => ({ error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const manual = response.json<AgentDirective>().files?.find((file) => file.path === MANUAL);
    expect(manual).toMatchObject({ text: null, bytes: null, modified_at: null, truncated: false });
  });

  it('degrada con un motivo cuando nadie midió ese contenedor, y no molesta al relay', async () => {
    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body).toMatchObject({
      publicado: true,
      medido: false,
      files: null,
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'contenedor no medido todavía (sin hechos de entorno)',
      },
    });
    expect(body.motivo).toContain('no medido');
//    Without facts, where the manual lives is unknown, so asking would be asking for an invented path.
    expect(pedidas).toEqual([]);
  });

  it('no sirve contenido cuando las rutas están deducidas del registro y no medidas', async () => {
    hechos.set('Steven:jarvis', { ...CLAUDE, source: 'database' });

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    const body = response.json<AgentDirective>();
    expect(body.files).toBeNull();
    expect(body.motivo).toContain('no medidas');
    expect(pedidas).toEqual([]);
  });

  it('no confunde un alias del tenant propio con el mismo nombre pedido bajo otro tenant', async () => {
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Miguel/jarvis/directive' });

//    Miguel:jarvis does not exist. Identity is the exact pair; it never falls through by alias to Steven:jarvis.
    expect(response.statusCode).toBe(404);
    expect(pedidas).toEqual([]);
  });

  it('sirve la directiva cross-tenant cuando la misma ACL allow_read que muestra la flota la autoriza', async () => {
    hechos.set('Miguel:atlas', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Miguel/atlas/directive' });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentDirective>()).toMatchObject({ publicado: true, medido: true });
    expect(pedidas).toEqual([{ tenant_id: 'Miguel', alias: 'atlas', path: MANUAL }]);
  });

  it('no revela una directiva cross-tenant sin ACL allow_read', async () => {
    hechos.set('Pablo:dedalo', CLAUDE);

    const response = await app.inject({ method: 'GET', url: '/v3/console/agents/Pablo/dedalo/directive' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
    expect(pedidas).toEqual([]);
  });

  it('exige el permiso de lectura de consola', async () => {
    await build({}, consoleAuthProvider({ permissions: ['route', 'control'] }));
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

    expect(response.statusCode).toBe(403);
    expect(pedidas).toEqual([]);
  });

  it('contesta 401 —no 500— al que no está autenticado', async () => {
    await build({}, {
      name: 'test-sin-sesion', mode: 'test',
      authenticateHttp: async () => { throw new AuthError(); },
      authenticateHello: async () => { throw new AuthError(); }
    });
    hechos.set('Steven:jarvis', CLAUDE);

    const response = await app.inject({ method: 'GET', url: DIRECTIVA });

//    The directive route does not catch anything internally: without the scope error handler, an
    // operator with an expired session would see "internal error" and look for the fault where it is not.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });
});

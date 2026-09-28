/* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { DatabasePool } from '@cauce/store';
import type { AuthProvider, Principal } from './auth.js';
import type { AgentPresence, TerminalSessionRow } from './terminal/types.js';
import { instrumentFailurePool } from './test-support/terminal-plugin.js';

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
  placements: { tenant_id: string; alias: string; container_name: string; runtime_user: string }[];
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
    ] satisfies readonly (readonly [string, string, string, string])[]).map(
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
      if (row?.consumed_at !== null || row.revoked_at !== null || row.closed_at !== null
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
      if (!row?.relay_claim_sha256?.equals(expectedDigest)
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
      if (!row?.consumed_at || row.revoked_at !== null || row.closed_at !== null
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
      if (row?.consumed_at !== null || row.revoked_at !== null || row.closed_at !== null
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
      if (row?.closed_at !== null) return { rows: [], rowCount: 0 };
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
    pool: instrumentFailurePool({
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
    } as unknown as DatabasePool),
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

export type { AuditRow, FakeDatabase };
export {
  CLAIM_A,
  CLAIM_B,
  MASTER,
  ORIGIN,
  RELAY_A,
  RELAY_B,
  RELAY_BOOT_A,
  RELAY_BOOT_B,
  RELAY_TOKEN,
  consoleAuthProvider,
  fakeDatabase,
  isOpen,
  presence,
};

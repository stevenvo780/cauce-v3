import type { FastifyRequest } from 'fastify';
import {
  lockConsoleHuman, lockTerminalControlLease, type DatabaseClient,
} from '@cauce/store';
import { AuthorizationError, MtlsAuthProvider, type AuthProvider } from '../auth.js';
import { hasCookie, scalarHeaderValue } from '../http-auth-primitives.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { consoleRoleAuthority } from '../console-user-authority.js';
import {
  AUTHORITY_CONTINUITY_MAX_BYTES, authorityContinuityCommitment, encodeTerminalSubject,
  humanAuthorityOrigin, machineAuthorityOrigin, verifyAuthorityContinuity,
  type AuthorityContinuityPayload, type TerminalAuthorityOrigin,
} from './authority-continuity.js';
import { cohortRoutingAuthority, containerCohort, loadFleetPlacements } from './authority.js';
import type { TerminalControlRepository } from './helpers.js';
import type { TerminalSessionRow } from './types.js';

export function authorityProof(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('ac2.')
      || Buffer.byteLength(value, 'utf8') > AUTHORITY_CONTINUITY_MAX_BYTES) {
    throw new AuthorizationError('terminal authority is unavailable');
  }
  return value;
}

export async function terminalDatabaseNow(client: DatabaseClient, deadline: Date): Promise<Date> {
  const result = await client.query<{ database_now: Date }>('SELECT clock_timestamp() AS database_now');
  const now = result.rows[0]?.database_now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())
      || !Number.isFinite(deadline.getTime()) || now >= deadline) {
    throw new AuthorizationError('terminal authority is unavailable');
  }
  return now;
}

type AdmissionRow = Pick<TerminalSessionRow, 'id' | 'request_id' | 'console_subject' | 'request_sha256'>;

export class TerminalSessionAuthority {
  constructor(private readonly provider: AuthProvider, private readonly key: Buffer) {}

  async capture(request: FastifyRequest): Promise<TerminalAuthorityOrigin> {
    if (this.provider instanceof PasswordAuthProvider) {
      const session = await this.provider.verifiedConsoleSession(request);
      if (session !== undefined) return humanAuthorityOrigin(session);
      if (hasCookie(scalarHeaderValue(request.headers.cookie), this.provider.cookieName)) throw new AuthorizationError();
    }
    const machine = this.machineProvider();
    if (machine === undefined) throw new AuthorizationError('terminal authority is unavailable');
    return machineAuthorityOrigin(await machine.verifiedTerminalMachine(request));
  }

  async browserProof(request: FastifyRequest, value: unknown): Promise<AuthorityContinuityPayload> {
    const payload = this.verify(value);
    const current = await this.capture(request);
    if (encodeTerminalSubject(current) !== encodeTerminalSubject(payload.origin)
        || (current.kind === 'human' && JSON.stringify(current) !== JSON.stringify(payload.origin))) {
      throw new AuthorizationError('terminal authority is unavailable');
    }
    return payload;
  }

  async lockCleanup(
    client: DatabaseClient, origin: TerminalAuthorityOrigin, sid: string, repository: TerminalControlRepository,
  ): Promise<void> {
    const deadline = await this.lockOrigin(client, origin);
    await repository.assertPermission(origin.actor.tenantId, origin.actor.alias, 'control', client, true);
    const peek = await client.query<TerminalSessionRow>('SELECT * FROM terminal_sessions WHERE id=$1', [sid]);
    const row = peek.rows[0];
    if (row?.console_subject !== encodeTerminalSubject(origin)) throw new AuthorizationError();
    await lockTerminalControlLease(client, { tenantId: row.tenant_id, alias: row.alias });
    await client.query('SELECT id FROM terminal_sessions WHERE id=$1 FOR UPDATE', [sid]);
    await client.query('SELECT id FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL ORDER BY id FOR UPDATE', [sid]);
    await terminalDatabaseNow(client, deadline);
  }

  private machineProvider(): MtlsAuthProvider | undefined {
    const candidate = this.provider instanceof PasswordAuthProvider ? this.provider.fallback : this.provider;
    return candidate instanceof MtlsAuthProvider ? candidate : undefined;
  }

  verify(value: unknown): AuthorityContinuityPayload {
    try { return verifyAuthorityContinuity(authorityProof(value), this.key); }
    catch { throw new AuthorizationError('terminal authority is unavailable'); }
  }

  matchRow(payload: AuthorityContinuityPayload, row: AdmissionRow): AuthorityContinuityPayload {
    if (payload.sessionId !== row.id || payload.requestId !== row.request_id
        || encodeTerminalSubject(payload.origin) !== row.console_subject
        || !authorityContinuityCommitment(payload).equals(row.request_sha256)) {
      throw new AuthorizationError('terminal authority is unavailable');
    }
    return payload;
  }

  async lockOrigin(client: DatabaseClient, origin: TerminalAuthorityOrigin): Promise<Date> {
    if (origin.kind === 'machine') {
      const machine = this.machineProvider();
      if (machine === undefined) throw new AuthorizationError();
      return machine.revalidateTerminalMachine(origin);
    }
    if (!(this.provider instanceof PasswordAuthProvider)) throw new AuthorizationError();
    const provider = this.provider;
    const snapshot = await lockConsoleHuman(client, origin.humanId, {
      credentialStamp: origin.credentialStamp,
      verifyCredentialStamp: (stamp, current) => provider.verifyCredentialStamp(stamp, current),
    });
    if (snapshot.account.defaultTenant !== origin.actor.tenantId
        || snapshot.account.actorAlias !== origin.actor.alias
        || snapshot.membership.tenantId !== origin.actor.tenantId
        || snapshot.membership.actorAlias !== origin.actor.alias
        || origin.issuedAtSeconds * 1000 < snapshot.account.passwordChangedAt - 1000) {
      throw new AuthorizationError();
    }
    for (const role of [snapshot.account.role, snapshot.membership.role]) {
      const ceiling = consoleRoleAuthority(role);
      if (!ceiling.roles.includes('operator') || !ceiling.permissions.includes('control')) {
        throw new AuthorizationError();
      }
    }
    if (!snapshot.membership.permissions.includes('control')) throw new AuthorizationError();
    return new Date(origin.expiresAtSeconds * 1000);
  }

  async lockTarget(
    client: DatabaseClient, origin: TerminalAuthorityOrigin,
    target: { tenant_id: string; alias: string }, repository: TerminalControlRepository,
  ): Promise<void> {
    await client.query('LOCK TABLE agents IN SHARE MODE');
    const actor = origin.actor;
    await repository.assertPermission(actor.tenantId, actor.alias, 'control', client, true);
    const cohort = containerCohort(await loadFleetPlacements(client), target.tenant_id, target.alias);
    if (cohort.length === 0) throw new AuthorizationError();
    for (const member of [...cohort, { tenant_id: actor.tenantId, alias: actor.alias }]
      .sort((left, right) => `${left.tenant_id}:${left.alias}`.localeCompare(`${right.tenant_id}:${right.alias}`))) {
      await client.query(
        `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.alias=$2
         ORDER BY membership.room_id FOR SHARE OF membership,room,tenant`,
        [member.tenant_id, member.alias],
      );
    }
    for (const tenant of [...new Set(cohort.map((member) => member.tenant_id))].sort()) {
      if (tenant !== actor.tenantId) await client.query(
        `SELECT edge.from_tenant FROM acl_edges edge
         JOIN tenants source ON source.id=edge.from_tenant
         JOIN tenants target ON target.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
         FOR SHARE OF edge,source,target`, [actor.tenantId, tenant],
      );
    }
    for (const member of cohort) {
      if (await repository.authorizeAgentTarget(actor.tenantId, actor.alias,
        member.tenant_id, member.alias, 'control', client) === undefined) throw new AuthorizationError();
    }
    if (!(await cohortRoutingAuthority(client, actor.tenantId, actor.alias, cohort)).allowed) throw new AuthorizationError();
  }

  async lockSession(
    client: DatabaseClient, payload: AuthorityContinuityPayload, repository: TerminalControlRepository,
  ): Promise<Date> {
    const peek = await client.query<TerminalSessionRow>(
      'SELECT * FROM terminal_sessions WHERE id=$1', [payload.sessionId],
    );
    const candidate = peek.rows[0];
    if (candidate === undefined) throw new AuthorizationError();
    this.matchRow(payload, candidate);
    await this.lockOrigin(client, payload.origin);
    await this.lockTarget(client, payload.origin, candidate, repository);
    await lockTerminalControlLease(client, { tenantId: candidate.tenant_id, alias: candidate.alias });
    const locked = await client.query<TerminalSessionRow>(
      'SELECT * FROM terminal_sessions WHERE id=$1 FOR UPDATE', [payload.sessionId],
    );
    const row = locked.rows[0];
    if (row === undefined) throw new AuthorizationError();
    this.matchRow(payload, row);
    await client.query(
      `SELECT id FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL
       ORDER BY id FOR UPDATE`, [payload.sessionId],
    );
    const deadline = payload.origin.kind === 'machine'
      ? await this.lockOrigin(client, payload.origin) : new Date(payload.origin.expiresAtSeconds * 1000);
    await terminalDatabaseNow(client, deadline);
    return deadline;
  }
}

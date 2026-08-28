import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionCloseReport, TerminalGatewayClient } from './gateway-client.js';
import { SessionManager, type SessionLimits } from './sessions.js';
import { grant, CLAIM_TOKEN, waitFor } from './relay-test-fixtures.js';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

class FakeGateway implements TerminalGatewayClient {
  closeFailures = 0;
  closeAttempts = 0;
  readonly closeReports: { sessionId: string; report: SessionCloseReport }[] = [];

  async consumeTicket(): Promise<never> {
    throw new Error('not used');
  }

  async resumeSession(): Promise<never> {
    throw new Error('not used');
  }

  async authorizeSession(): Promise<never> {
    throw new Error('not used');
  }

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    this.closeAttempts += 1;
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('simulated gateway close failure');
    }
    this.closeReports.push({ sessionId, report });
  }

  async publishPresence(): Promise<void> {
    // no-op for spool tests
  }
}

function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    idleTimeoutMs: 60_000,
    outputRateBytesPerSec: 262_144,
    scrollbackBytes: 4_096,
    maxSessions: 4,
    authzIntervalMs: 60_000,
    authzGraceMs: 60_000,
    openTimeoutMs: 2_000,
    ...overrides,
  };
}

describe('SessionManager close report spool persistence', () => {
  it('persiste el cierre antes de reintentar y limpia el spool cuando vuelve el gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-'));
    const spool = join(directory, 'reports.json');
    const gateway = new FakeGateway();
    gateway.closeFailures = 2;
    const manager = new SessionManager({ gateway, limits: limits(), closeSpoolFile: spool });
    try {
      manager.reportConsumedClose(SESSION_ID, 'agent_offline', grant());
      const pending = JSON.parse(await readFile(spool, 'utf8')) as {
        readonly version: number;
        readonly reports: readonly { readonly session_id: string; readonly reason: string }[];
      };
      expect(pending).toEqual({
        version: 2,
        reports: [{
          session_id: SESSION_ID,
          reason: 'agent_offline',
          exit_code: null,
          bytes_in: 0,
          bytes_out: 0,
          claim_token: CLAIM_TOKEN,
          claim_epoch: '1',
        }],
      });
      expect((await stat(spool)).mode & 0o777).toBe(0o600);

      await waitFor(() => gateway.closeReports.length === 1);
      expect(gateway.closeAttempts).toBe(3);
      const delivered = JSON.parse(await readFile(spool, 'utf8')) as {
        readonly version: number;
        readonly reports: readonly unknown[];
      };
      expect(delivered).toEqual({ version: 2, reports: [] });
    } finally {
      await manager.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains a version-1 legacy close spool but writes only strict version-2 reports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-v1-'));
    const spool = join(directory, 'reports.json');
    await writeFile(spool, JSON.stringify({
      version: 1,
      reports: [{
        session_id: SESSION_ID,
        reason: 'legacy_restart',
        exit_code: null,
        bytes_in: 3,
        bytes_out: 5,
      }],
    }), { mode: 0o600 });
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits(), closeSpoolFile: spool });
    try {
      await waitFor(() => gateway.closeReports.length === 1);
      expect(gateway.closeReports[0]).toEqual({
        sessionId: SESSION_ID,
        report: {
          reason: 'legacy_restart', exit_code: null, bytes_in: 3, bytes_out: 5,
        },
      });
      expect(JSON.parse(await readFile(spool, 'utf8'))).toEqual({ version: 2, reports: [] });
    } finally {
      await manager.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a version-2 capability spool that is readable by group or other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-mode-'));
    const spool = join(directory, 'reports.json');
    await writeFile(spool, JSON.stringify({
      version: 2,
      reports: [{
        session_id: SESSION_ID,
        reason: 'private_claim',
        exit_code: null,
        bytes_in: 0,
        bytes_out: 0,
        claim_token: CLAIM_TOKEN,
        claim_epoch: '1',
      }],
    }));
    await chmod(spool, 0o644);
    try {
      expect(() => new SessionManager({
        gateway: new FakeGateway(), limits: limits(), closeSpoolFile: spool,
      })).toThrow(/mode 0600/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

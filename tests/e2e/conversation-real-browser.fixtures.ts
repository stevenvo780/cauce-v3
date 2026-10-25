import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CauceRepository } from '../../packages/store/src/index.js';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
export const evidenceDirectory = resolve(process.env.CAUCE_E2E_ARTIFACT_DIR ?? '/tmp/cauce-programa-20261003/pr52-browser-review');

export interface ConversationBrowserFixture {
  readonly pty: RealPtyFixture;
  readonly repository: CauceRepository;
  roomId(): Promise<string>;
  close(): Promise<void>;
}

export async function startConversationBrowserFixture(): Promise<ConversationBrowserFixture> {
  await mkdir(evidenceDirectory, { recursive: true });
  const pty = await startRealPtyFixture();
  return {
    pty,
    repository: new CauceRepository(pty.database.pool),
    async roomId() {
      const result = await pty.database.pool.query<{ room_id: string }>(
        `SELECT actor.room_id FROM memberships actor
          JOIN memberships target ON target.tenant_id=actor.tenant_id AND target.room_id=actor.room_id
         WHERE actor.tenant_id=$1 AND actor.alias=$2 AND actor.enabled
           AND target.alias=$3 AND target.enabled
         ORDER BY actor.room_id LIMIT 2`,
        [pty.tenant, pty.operatorAlias, pty.targetAlias],
      );
      if (result.rows.length !== 1 || !result.rows[0]?.room_id) {
        throw new Error('fixture operator and target must share exactly one durable room');
      }
      return result.rows[0].room_id;
    },
    close: () => pty.close(),
  };
}

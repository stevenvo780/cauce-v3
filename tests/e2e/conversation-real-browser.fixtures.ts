import { mkdir } from 'node:fs/promises';
import { CauceRepository } from '../../packages/store/src/index.js';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import type { BrowserPage } from './console-functional-browser.fixtures.js';

export const evidenceDirectory = '/tmp/cauce-programa-20261003/pr52-browser-review';

interface FaultRoute {
  request(): { method(): string };
  fulfill(options: { status: number; contentType: string; body: string }): Promise<void>;
  continue(): Promise<void>;
}

interface RouteCapablePage extends BrowserPage {
  route(url: string, handler: (route: FaultRoute) => Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
}

export interface ConfirmFault {
  waitForCalls(count: number): Promise<void>;
  releaseNext(): Promise<void>;
  remove(): Promise<void>;
  readonly calls: number;
}

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

export async function injectConfirm503(page: BrowserPage): Promise<ConfirmFault> {
  const routePage = page as unknown as RouteCapablePage;
  const pattern = '**/v3/console/publish-intents/confirm';
  const waiting: (() => Promise<void>)[] = [];
  let calls = 0;
  await routePage.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    calls += 1;
    await new Promise<void>((resolve) => {
      waiting.push(async () => {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'operation_unavailable', test_fault: 'one local confirm response' }),
        });
        resolve();
      });
    });
  });
  return {
    get calls() { return calls; },
    async waitForCalls(expected) {
      const deadline = Date.now() + 10_000;
      while (calls < expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (calls < expected) throw new Error(`confirmation fault proxy saw ${String(calls)} requests, expected ${String(expected)}`);
    },
    async releaseNext() {
      const release = waiting.shift();
      if (!release) throw new Error('no held confirmation request is available to release');
      await release();
    },
    remove: () => routePage.unroute(pattern),
  };
}

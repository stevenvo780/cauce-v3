import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ackEnvelope, terminalAck } from '../../packages/store/test/helpers/consumer.js';
import type { Locator } from './console-functional-browser.fixtures.js';
import {
  evidenceDirectory, injectConfirm503, startConversationBrowserFixture,
  type ConversationBrowserFixture,
} from './conversation-real-browser.fixtures.js';

let fixture: ConversationBrowserFixture | undefined;
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

interface InputLocator extends Locator {
  inputValue(): Promise<string>;
  isDisabled(): Promise<boolean>;
}

beforeAll(async () => {
  fixture = await startConversationBrowserFixture();
  console.info(JSON.stringify({
    e2e: 'PR52 real conversation browser',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
    postgresContainer: fixture.pty.database.container.getId(),
    browserContainer: fixture.pty.browserContainer,
    agentContainer: fixture.pty.agentContainerId,
    evidenceDirectory,
  }));
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function openConversation(active: ConversationBrowserFixture, viewport: { width: number; height: number }) {
  const page = await active.pty.browserPage(viewport);
  const response = await page.goto(active.pty.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo', { exact: true }).fill(active.pty.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(active.pty.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  const conversations = page.getByRole('link', { name: 'Conversaciones', exact: true });
  await conversations.waitFor({ state: 'visible', timeout: 20_000 });
  await conversations.click();
  const agent = page.getByRole('button', { name: new RegExp(`^Conversación con ${active.pty.targetAlias}, ${active.pty.tenant},`) });
  await agent.waitFor({ state: 'visible', timeout: 20_000 });
  await agent.click();
  await page.getByLabel(`Mensaje para ${active.pty.targetAlias}`, { exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  return page;
}

async function messageEvidence(active: ConversationBrowserFixture, text: string) {
  const result = await active.pty.database.pool.query<{
    message_id: string;
    actor_alias: string;
    idempotency_key: string;
    delivery_id: string;
    status: string;
    initiators: string;
    outbox: string;
    prepare: string;
    confirm: string;
  }>(
    `SELECT m.id::text AS message_id,m.actor_alias,ik.idempotency_key,d.id::text AS delivery_id,d.status,
            (SELECT count(*)::text FROM audit_events a WHERE a.action='message.publish'
              AND a.message_id=m.id AND a.trace_id=m.trace_id
              AND a.metadata->'console_author'->>'kind'='human') AS initiators,
            (SELECT count(*)::text FROM adapter_outbox o WHERE o.message_id=m.id) AS outbox,
            (SELECT count(*)::text FROM audit_events a WHERE a.action='console.publish.prepare'
              AND a.metadata->>'idempotency_key'=ik.idempotency_key) AS prepare,
            (SELECT count(*)::text FROM audit_events a WHERE a.action='console.publish.confirm'
              AND a.metadata->>'idempotency_key'=ik.idempotency_key) AS confirm
       FROM messages m JOIN idempotency_keys ik ON ik.message_id=m.id
       JOIN deliveries d ON d.message_id=m.id
      WHERE m.tenant_id=$1 AND m.actor_alias=$2 AND m.body->>'text'=$3`,
    [active.pty.tenant, active.pty.operatorAlias, text],
  );
  if (result.rows.length !== 1) throw new Error(`expected one durable root for marker; found ${String(result.rows.length)}`);
  const row = result.rows[0];
  if (!row) throw new Error('durable message evidence row is absent');
  return row;
}

async function ackFromActualStore(
  active: ConversationBrowserFixture,
  messageId: string,
  reply: string,
  observeStarted: () => Promise<void>,
): Promise<void> {
  const instanceId = `pr52-browser-consumer-${randomUUID()}`;
  const lease = await active.repository.acquireLease(active.pty.tenant, active.pty.targetAlias, instanceId, [], 60_000, { takeover: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('real store could not acquire the recipient lease for the browser-published root');
  }
  const deliveries = await active.repository.claimDeliveries(
    active.pty.tenant, active.pty.targetAlias, instanceId, lease.epoch, 10, 30_000, 3, {}, lease.connection_token,
  );
  const delivery = deliveries.find((candidate) => candidate.message_id === messageId);
  if (!delivery) throw new Error('real store lease did not claim the browser-published delivery');
  const target = { instanceId, epoch: lease.epoch };
  const started = await active.repository.ackDelivery(
    delivery.delivery_id, active.pty.tenant, active.pty.targetAlias,
    ackEnvelope(delivery, target, { progress: 'fixture agent started' }, {
      status: 'started', execution_started: true, retryable: false,
    }),
  );
  expect(started).toMatchObject({ applied: true, status: 'started' });
  await observeStarted();
  const done = await active.repository.ackDelivery(
    delivery.delivery_id, active.pty.tenant, active.pty.targetAlias,
    terminalAck(delivery, target, { reply }),
  );
  expect(done).toMatchObject({ applied: true, status: 'done' });
}

describe('PR52 human conversation and durable reply in real Chromium', () => {
  it('shows durable acceptance, then a fenced agent reply on desktop and mobile', async () => {
    if (!fixture) throw new Error('conversation browser fixture was not initialized');
    const active = fixture;
    const sharedRoom = await active.roomId();
    const viewports = [
      { label: 'desktop', width: 1440, height: 900 },
      { label: 'mobile', width: 360, height: 800 },
    ] as const;

    for (const viewport of viewports) {
      const page = await openConversation(active, { width: viewport.width, height: viewport.height });
      const marker = `pr52-${viewport.label}-${randomUUID()}`;
      const reply = `respuesta real ${viewport.label} ${randomUUID()}`;
      const textbox = page.getByLabel(`Mensaje para ${active.pty.targetAlias}`, { exact: true });
      await textbox.fill(marker);
      const fault = await injectConfirm503(page);
      const send = page.getByRole('button', { name: 'Enviar', exact: true }) as unknown as {
        click(options?: { clickCount?: number }): Promise<void>;
      };
      await send.click({ clickCount: 2 });

      const humanEntry = page.locator('.transcript-entry.input').filter({ hasText: marker });
      const pendingCheck = humanEntry.getByRole('status', {
        name: 'Entrega: Publicado · esperando aceptación del agente', exact: true,
      });
      await pendingCheck.waitFor({ state: 'visible', timeout: 20_000 });
      expect(await humanEntry.locator('[data-checks="1"]').count()).toBe(1);
      expect(await humanEntry.locator('[data-checks="2"]').count()).toBe(0);
      expect(await humanEntry.locator('.canonical-reply').count()).toBe(0);
      const confirmingButton = page.getByRole('button', { name: 'Confirmando…', exact: true });
      await confirmingButton.waitFor({ state: 'visible', timeout: 10_000 });
      await fault.waitForCalls(1);
      expect(await (confirmingButton as InputLocator).isDisabled()).toBe(true);
      expect(await (page.locator('textarea') as InputLocator).inputValue()).toBe('');
      expect(new URL(page.url()).pathname).toBe(`/messages/${active.pty.tenant}/${active.pty.targetAlias}`);
      const pendingRoot = await messageEvidence(active, marker);
      expect(pendingRoot).toMatchObject({ actor_alias: active.pty.operatorAlias, status: 'pending', initiators: '1', outbox: '1', prepare: '1', confirm: '0' });
      expect(await active.roomId()).toBe(sharedRoom);
      await page.screenshot({ path: `${evidenceDirectory}/${viewport.label}-accepted-confirm-pending.png`, fullPage: false });

      await fault.releaseNext();
      await fault.waitForCalls(2);
      expect((await messageEvidence(active, marker)).confirm).toBe('0');
      await fault.releaseNext();
      await page.getByText(/Confirmación incierta; intención pendiente/u)
        .waitFor({ state: 'visible', timeout: 20_000 });
      await fault.remove();
      expect((await messageEvidence(active, marker)).message_id).toBe(pendingRoot.message_id);
      expect(await page.getByText(marker, { exact: true }).count()).toBe(1);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel(`Mensaje para ${active.pty.targetAlias}`, { exact: true })
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByText(marker, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      expect((await messageEvidence(active, marker)).message_id).toBe(pendingRoot.message_id);
      expect(await page.getByText(marker, { exact: true }).count()).toBe(1);

      const author = humanEntry.locator('.transcript-direction span[title^="Persona autenticada"]');
      await author.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await author.innerText()).toBe('REAL PTY E2E OPERATOR');
      const details = humanEntry.getByText(/^Detalles del mensaje/u);
      await details.press('Enter');
      await humanEntry.getByText(`Identidad técnica: ${active.pty.tenant}:${active.pty.operatorAlias} · destino: ${active.pty.tenant}:${active.pty.targetAlias}`, { exact: true })
        .waitFor({ state: 'visible', timeout: 10_000 });
      const focusedDetails = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(focusedDetails).toBe('SUMMARY');
      await page.screenshot({ path: `${evidenceDirectory}/${viewport.label}-message-details-open.png`, fullPage: false });

      await ackFromActualStore(active, pendingRoot.message_id, reply, async () => {
        const startedCheck = humanEntry.getByRole('status', {
          name: 'Entrega: El agente inició la ejecución', exact: true,
        });
        await startedCheck.waitFor({ state: 'visible', timeout: 20_000 });
        expect(await humanEntry.locator('[data-checks="1"]').count()).toBe(1);
        expect(await humanEntry.locator('[data-checks="2"]').count()).toBe(0);
        expect(await humanEntry.locator('.canonical-reply').count()).toBe(0);
        const inProgress = await active.pty.database.pool.query<{ status: string }>(
          'SELECT status FROM deliveries WHERE id=$1::uuid', [pendingRoot.delivery_id],
        );
        expect(inProgress.rows[0]?.status).toBe('started');
        expect(await page.getByText('Respuesta consolidada', { exact: true }).count()).toBe(0);
        expect(await page.getByText(reply, { exact: true }).count()).toBe(0);
      });
      const completed = await active.pty.database.pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE id=$1::uuid', [pendingRoot.delivery_id],
      );
      expect(completed.rows[0]?.status).toBe('done');
      await page.getByText(reply, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByText('Respuesta consolidada', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const doneCheck = humanEntry.getByRole('status', {
        name: 'Entrega: El agente terminó; respuesta recibida', exact: true,
      });
      await doneCheck.waitFor({ state: 'visible', timeout: 20_000 });
      expect(await humanEntry.locator('[data-checks="1"]').count()).toBe(0);
      expect(await humanEntry.locator('[data-checks="2"]').count()).toBe(1);
      const agentBubble = page.getByRole('article', { name: `Mensaje de ${active.pty.targetAlias}`, exact: true });
      expect(await agentBubble.count()).toBe(1);
      expect(await agentBubble.innerText()).toContain(reply);
      expect(await page.getByText(marker, { exact: true }).count()).toBe(1);
      expect((await messageEvidence(active, marker)).message_id).toBe(pendingRoot.message_id);
      await page.screenshot({ path: `${evidenceDirectory}/${viewport.label}-agent-reply-done.png`, fullPage: false });
      console.info(JSON.stringify({ viewport: viewport.label, messageId: pendingRoot.message_id,
        deliveryId: pendingRoot.delivery_id, roomId: sharedRoom, confirmFaults: fault.calls,
        outcome: 'one durable human root, started then done ACK, canonical reply shown in a separate agent bubble' }));
    }
  }, 10 * 60_000);
});

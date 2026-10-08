import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import { registerHumanPublishSuite } from './human-publish-authority-postgres.fixtures.js';
import {
  claimConsumer, claims, databasePool, getRepository, publishRoot, seedHumanPublishActor,
} from './human-message-claims-postgres.fixtures.js';

/*
 * The console account of a person is bound to an agent alias (Steven → kant), so the root message the
 * person sends carries `actor_alias='kant'`. Read as "kant delegated to argos", the console painted
 * kant as busy delegating for as long as argos worked, while kant itself was idle.
 */

registerHumanPublishSuite(import.meta.url);

interface Item {
  message_id: string; from_tenant: string | null; from_alias: string | null;
  from_human: boolean; origin_adapter: string | null;
}
interface Agent { tenant_id: string; alias: string; in_flight_items: Item[] }

async function inFlightOf(alias: string): Promise<Item[]> {
  const snapshot = await getRepository().fleetActivity('Steven', 'kant') as unknown as { agents: Agent[] };
  const agent = snapshot.agents.find((candidate) => candidate.tenant_id === 'Steven' && candidate.alias === alias);
  if (agent === undefined) throw new Error(`${alias} is missing from fleetActivity`);
  return agent.in_flight_items;
}

/** What kant's own adapter publishes: no human initiator behind it. */
function agentMessage(): PublishMessage {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'kant delega de verdad' },
    idempotency_key: randomUUID(), lane: 'interactive', priority: 0,
  };
}

describe('fleetActivity attributes in-flight work to who really sent it', () => {
  it('a person bound to kant is no kant delegation; a message kant itself sends still is', async () => {
    const person = await seedHumanPublishActor('kant');
    const { receipt: human } = await publishRoot(person);
    const agent = await getRepository().publish(agentMessage());
    const argos = await claimConsumer('argos');
    const claimed = (await claims(argos)).map((delivery) => delivery.message_id).sort();
    expect(claimed).toEqual([human.message_id, agent.message_id].sort());

    const channel = (await databasePool().query<{ auth_channel: string }>(
      'SELECT auth_channel FROM messages WHERE id=$1', [human.message_id])).rows[0]?.auth_channel;
    expect(['console', 'human-mcp']).toContain(channel);
    const items = await inFlightOf('argos');
    expect(items.find((item) => item.message_id === human.message_id)).toMatchObject({
      from_tenant: null, from_alias: null, from_human: true, origin_adapter: channel,
    });
    expect(items.find((item) => item.message_id === agent.message_id)).toMatchObject({
      from_tenant: 'Steven', from_alias: 'kant', from_human: false, origin_adapter: null,
    });
    const edges = items.flatMap((item) => (item.from_tenant && item.from_alias ? [`${item.from_alias}->argos`] : []));
    expect(edges).toEqual(['kant->argos']);
  });
});

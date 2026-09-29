import { beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, Tenant } from '@cauce/protocol';
import {
  withheldGateQuestion, withheldGateRelayText
} from '../src/repository/agents/chain-control/outputs.js';
import {
  command, pool, registerAgentOutputSuite, repository,
} from './agent-output-postgres-helpers.js';
import {
  ackWith, consumer as leaseConsumer, nextDelivery, type Consumer
} from './helpers/consumer.js';

registerAgentOutputSuite(import.meta.url);

// El gate `@human` relaya la pregunta al canal humano del ROOT. Un salto hondo de otro tenant
// cliente (salva(Isa)→jarvis(Steven)→kratos(Miguel)) es legal arista por arista, pero la
// pregunta de kratos llegaba al Telegram de Isa. Y con un gate abierto, cualquiera que delegara
// en esa raíz recibía la pregunta en su rechazo 'chain_gated', fuera del tenant que fuera.

const preguntaMiguel = 'PREGUNTA-PRIVADA-DE-MIGUEL-no-debe-cruzar';
const preguntaIsa = 'PREGUNTA-PRIVADA-DE-ISA-no-debe-cruzar';

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias, 600_000);

async function publishIsaRoot(salva: Consumer): Promise<DeliveryEnvelope> {
  await repository.publish(command({
    tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'pedido de Isa' },
    authenticated_context: {
      session_id: 'gate-isa-session',
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: 'gate-isa-chat',
        relay: [],
        metadata: { bridge_alias: 'salva', bridge_tenant: 'Isa' }
      }
    }
  }));
  return nextDelivery(repository, salva);
}

async function gateRelays(traceId: string): Promise<{ tenant_id: string; reply: string }[]> {
  return (await pool.query<{ tenant_id: string; reply: string }>(
    `SELECT tenant_id,payload#>>'{result,output,reply}' AS reply FROM adapter_outbox
     WHERE kind='origin_relay' AND idempotency_key LIKE 'chain-gate:%' AND trace_id=$1`,
    [traceId]
  )).rows;
}

describe('el gate humano no cruza la pregunta entre tenants cliente', () => {
  // En prod `human_gate_enabled` está encendido; la base de prueba nace con él apagado.
  beforeEach(async () => {
    await pool.query(`UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default'`);
  });

  it('la pregunta de kratos(Miguel) no llega al Telegram de Isa; el gate se cierra con un marcador neutro', async () => {
    const salva = await consumer('Isa', 'salva');
    const jarvis = await consumer('Steven', 'jarvis');
    const kratos = await consumer('Miguel', 'kratos');
    const root = await publishIsaRoot(salva);
    await ackWith(repository, salva, root, { messages: [{ to: 'jarvis', body: 'ayudame' }], reply: null });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'kratos', body: 'rama kratos' }], reply: null
    });
    const leaf = await nextDelivery(repository, kratos);
    const result = await ackWith(repository, kratos, leaf, {
      messages: [{ to: '@human', body: preguntaMiguel }], reply: null
    });

    expect(await gateRelays(root.trace_id)).toEqual([{ tenant_id: 'Isa', reply: withheldGateRelayText }]);
    expect((await pool.query(
      `SELECT tenant_id,status FROM agent_chain_gates WHERE root_message_id=$1`, [root.message_id]
    )).rows).toEqual([{ tenant_id: 'Miguel', status: 'cancelled' }]);
    // Nadie queda esperando a una persona que nunca va a ver la pregunta.
    expect(result.chain_gate).toBeUndefined();
    expect(result.delegation_rejections).toEqual([
      expect.objectContaining({ code: 'unroutable_alias', target: '@human' })
    ]);
    const isaOutbox = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM adapter_outbox WHERE tenant_id='Isa'`
    );
    expect(JSON.stringify(isaOutbox.rows)).not.toContain(preguntaMiguel);
  });

  it('con un gate de salva(Isa) abierto, kratos(Miguel) que delega en la raíz no recibe la pregunta', async () => {
    const salva = await consumer('Isa', 'salva');
    const jarvis = await consumer('Steven', 'jarvis');
    const socrates = await consumer('Steven', 'socrates');
    const kratos = await consumer('Miguel', 'kratos');
    const root = await publishIsaRoot(salva);
    await ackWith(repository, salva, root, {
      messages: [{ to: 'jarvis', body: 'rama larga' }, { to: 'socrates', body: 'rama corta' }],
      reply: null
    });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'kratos', body: 'rama kratos' }], reply: null
    });
    await ackWith(repository, socrates, await nextDelivery(repository, socrates), { reply: 'socrates listo' });
    const continuation = await nextDelivery(
      repository, salva, (delivery) => delivery.body.type === 'agent.response'
    );
    const opened = await ackWith(repository, salva, continuation, {
      messages: [{ to: '@human', body: preguntaIsa }], reply: null
    });
    // Control: la persona de Isa sí lee la pregunta de su propio agente.
    expect(opened.chain_gate?.question).toBe(preguntaIsa);
    const relays = await gateRelays(root.trace_id);
    expect(relays.map((relay) => relay.tenant_id)).toEqual(['Isa']);
    expect(relays[0]?.reply).toContain(preguntaIsa);

    const leaf = await nextDelivery(repository, kratos);
    const blocked = await ackWith(repository, kratos, leaf, {
      messages: [{ to: 'janus', body: 'seguí vos' }], reply: null
    });
    expect(blocked.delegation_rejections).toEqual([expect.objectContaining({ code: 'chain_gated' })]);
    expect(blocked.chain_gate?.question).toBe(withheldGateQuestion);
    expect(JSON.stringify(blocked)).not.toContain(preguntaIsa);
    const stored = await pool.query<{ correlation: unknown }>(
      `SELECT correlation FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND rejection_code='chain_gated'`,
      [leaf.delivery_id]
    );
    expect(stored.rowCount).toBe(1);
    expect(JSON.stringify(stored.rows)).not.toContain(preguntaIsa);
    const audited = await pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events WHERE tenant_id='Miguel' AND action='agent_output.materialize'`
    );
    expect(JSON.stringify(audited.rows)).not.toContain(preguntaIsa);
  });

  it('un salto hondo del hub sí relaya su pregunta al root cliente y suspende la rama', async () => {
    const salva = await consumer('Isa', 'salva');
    const jarvis = await consumer('Steven', 'jarvis');
    const socrates = await consumer('Steven', 'socrates');
    const root = await publishIsaRoot(salva);
    await ackWith(repository, salva, root, { messages: [{ to: 'jarvis', body: 'ayudame' }], reply: null });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'socrates', body: 'rama socrates' }], reply: null
    });
    const result = await ackWith(repository, socrates, await nextDelivery(repository, socrates), {
      messages: [{ to: '@human', body: 'pregunta del hub' }], reply: null
    });
    expect(result.chain_gate?.question).toBe('pregunta del hub');
    expect((await gateRelays(root.trace_id))[0]?.reply).toContain('pregunta del hub');
    expect((await pool.query(
      `SELECT status FROM agent_chain_gates WHERE root_message_id=$1`, [root.message_id]
    )).rows).toEqual([{ status: 'open' }]);
  });
});

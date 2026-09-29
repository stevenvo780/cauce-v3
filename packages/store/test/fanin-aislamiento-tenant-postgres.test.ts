import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, Tenant } from '@cauce/protocol';
import { DEFAULT_ACK_DEADLINE_MS } from '../src/index.js';
import { agentFaninWithheldText } from '../src/repository/agents/fanin/helpers.js';
import {
  command, pool, registerAgentOutputSuite, repository,
} from './agent-output-postgres-helpers.js';
import {
  ackEnvelope, ackWith, consumer as leaseConsumer, nextDelivery, type Consumer
} from './helpers/consumer.js';

registerAgentOutputSuite(import.meta.url);

// T9. El fan-in de un root de cliente juntaba las ramas de TODOS los saltos de la cadena, y el
// hub-star sólo vigila cada arista por separado: seneca(Pablo)→kant→jarvis(Steven)→atlas(Miguel)
// es legal salto a salto, pero el fan-in le entregaba a seneca el texto de atlas. En producción
// pasó una vez (07-27): salva(Isa) recibió el texto de kratos y janus(Miguel).

const secreto = 'MIGUEL-PRIVADO-no-debe-cruzar';
const informe = Buffer.alloc(512, 0x4d);

// Arriendo largo: una cadena de cuatro saltos con su drenaje dura más que el arriendo por defecto.
const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias, 600_000);

async function ackWithSecret(target: Consumer, delivery: DeliveryEnvelope): Promise<void> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    ackEnvelope(delivery, target, {
      output: {
        reply: `${target.alias}: ${secreto}`,
        messages: [],
        status: 'done',
        retryable: false,
        artifacts: [{
          name: `${target.alias}-privado.pdf`,
          uri: `data:application/pdf;base64,${informe.toString('base64')}`,
          sha256: createHash('sha256').update(informe).digest('hex')
        }]
      }
    })
  );
  expect(result.applied).toBe(true);
}

// Los coordinadores intermedios cierran cada turno sin repetir nada de lo que recibieron, así
// que cualquier rastro del secreto en el fan-in sólo puede venir de la materialización.
async function drainUntilFanin(root: Consumer, coordinators: Consumer[]): Promise<DeliveryEnvelope> {
  for (let round = 0; round < 12; round += 1) {
    for (const target of [...coordinators, root]) {
      const claimed = await repository.claimDeliveries(
        target.tenant, target.alias, target.instanceId, target.epoch, 10, DEFAULT_ACK_DEADLINE_MS
      );
      for (const delivery of claimed) {
        if (target === root && delivery.body.type === 'agent.fanin') return delivery;
        await ackWith(repository, target, delivery, { reply: `${target.alias} cerró su turno` });
      }
    }
  }
  throw new Error(`la cadena nunca produjo el fan-in de ${root.alias}`);
}

interface FaninResponse {
  tenant_id: string;
  alias: string;
  untrusted_text: string;
  artifacts?: unknown[];
}

const responsesOf = (fanin: DeliveryEnvelope): FaninResponse[] =>
  (fanin.body.fanin_data_v1 as { responses: FaninResponse[] }).responses;

describe('T9: el fan-in no cruza texto entre tenants cliente', () => {
  it('seneca(Pablo)→kant→jarvis(Steven)→atlas(Miguel) no le entrega a seneca el texto de atlas', async () => {
    const seneca = await consumer('Pablo', 'seneca');
    const kant = await consumer('Steven', 'kant');
    const jarvis = await consumer('Steven', 'jarvis');
    const atlas = await consumer('Miguel', 'atlas');
    await repository.publish(command({
      tenant_id: 'Pablo', room_id: 'grp.pablo', actor_alias: 'dedalo',
      recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
      body: { text: 'averiguá lo de atlas' }
    }));
    const root = await nextDelivery(repository, seneca);
    await ackWith(repository, seneca, root, { messages: [{ to: 'kant', body: 'salto uno' }], reply: null });
    await ackWith(repository, kant, await nextDelivery(repository, kant), {
      messages: [{ to: 'jarvis', body: 'salto dos' }], reply: null
    });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'atlas', body: 'salto tres' }], reply: null
    });
    await ackWithSecret(atlas, await nextDelivery(repository, atlas));
    expect((await pool.query(
      `SELECT max(hop_count)::int AS hops FROM agent_output_materializations
       WHERE correlation->>'root_message_id'=$1 AND status='materialized'`,
      [root.message_id]
    )).rows).toEqual([{ hops: 3 }]);

    const fanin = await drainUntilFanin(seneca, [atlas, jarvis, kant]);
    const rendered = JSON.stringify(fanin.body);
    expect(responsesOf(fanin).map((branch) => `${branch.tenant_id}/${branch.alias}`))
      .toEqual(['Steven/kant']);
    expect(rendered).not.toContain(secreto);
    expect(rendered).not.toContain('atlas-privado.pdf');
    expect(rendered).not.toContain('Miguel');
  });

  it('la variante 07-27: salva(Isa)→jarvis→kratos,janus(Miguel) no le entrega a salva el texto de Miguel', async () => {
    const salva = await consumer('Isa', 'salva');
    const jarvis = await consumer('Steven', 'jarvis');
    const kratos = await consumer('Miguel', 'kratos');
    const janus = await consumer('Miguel', 'janus');
    await repository.publish(command({
      tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      body: { text: 'pedido de Isa' }
    }));
    const root = await nextDelivery(repository, salva);
    await ackWith(repository, salva, root, { messages: [{ to: 'jarvis', body: 'ayudame' }], reply: null });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'kratos', body: 'rama kratos' }, { to: 'janus', body: 'rama janus' }],
      reply: null
    });
    await ackWithSecret(kratos, await nextDelivery(repository, kratos));
    await ackWithSecret(janus, await nextDelivery(repository, janus));

    const fanin = await drainUntilFanin(salva, [kratos, janus, jarvis]);
    const rendered = JSON.stringify(fanin.body);
    expect(responsesOf(fanin).map((branch) => `${branch.tenant_id}/${branch.alias}`))
      .toEqual(['Steven/jarvis']);
    expect(rendered).not.toContain(secreto);
    expect(rendered).not.toContain('kratos-privado.pdf');
    expect(rendered).not.toContain('janus-privado.pdf');
  });

  it('un hijo directo de un tenant sin arista de lectura deja un marcador neutro sin texto ni adjuntos', async () => {
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command({
      actor_alias: 'kant', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }]
    }));
    const root = await nextDelivery(repository, jarvis);
    await ackWith(repository, jarvis, root, { messages: [{ to: 'seneca', body: 'rama Pablo' }], reply: null });
    // La ruta de vuelta Pablo→Steven sigue abierta, así que la respuesta directa se acepta;
    // lo que se retira es la lectura Steven→Pablo, y el fan-in es el único que debe notarlo.
    await pool.query(
      `UPDATE acl_edges SET allow_read=false WHERE from_tenant='Steven' AND to_tenant='Pablo'`
    );
    await ackWithSecret(seneca, await nextDelivery(repository, seneca));

    const fanin = await drainUntilFanin(jarvis, [seneca]);
    expect(responsesOf(fanin)).toEqual([expect.objectContaining({
      tenant_id: 'Pablo',
      alias: 'seneca',
      untrusted_text: agentFaninWithheldText,
      truncated: false
    })]);
    expect(responsesOf(fanin)[0]).not.toHaveProperty('artifacts');
    const rendered = JSON.stringify(fanin.body);
    expect(rendered).not.toContain(secreto);
    expect(rendered).not.toContain('seneca-privado.pdf');
  });

  it('una continuación denegada del hijo directo no arrastra los adjuntos del nieto de otro cliente', async () => {
    const salva = await consumer('Isa', 'salva');
    const jarvis = await consumer('Steven', 'jarvis');
    const kratos = await consumer('Miguel', 'kratos');
    await repository.publish(command({
      tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      body: { text: 'pedido de Isa' }
    }));
    const root = await nextDelivery(repository, salva);
    await ackWith(repository, salva, root, { messages: [{ to: 'jarvis', body: 'ayudame' }], reply: null });
    await ackWith(repository, jarvis, await nextDelivery(repository, jarvis), {
      messages: [{ to: 'kratos', body: 'rama kratos' }], reply: 'jarvis delegó en kratos'
    });
    await ackWithSecret(kratos, await nextDelivery(repository, kratos));
    const continuation = await nextDelivery(
      repository, jarvis, (delivery) => delivery.body.type === 'agent.response'
    );
    // La auditoría 'deny' de esta continuación apunta al mensaje de kratos, que trae sus adjuntos.
    await pool.query(
      `UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Isa'`
    );
    await ackWith(repository, jarvis, continuation, { reply: 'jarvis revisó lo de kratos' });

    const fanin = await drainUntilFanin(salva, [jarvis]);
    const [branch] = responsesOf(fanin);
    expect(responsesOf(fanin)).toHaveLength(1);
    expect(branch?.untrusted_text).toContain('Agent response denied: reverse_acl_unavailable');
    expect(branch).not.toHaveProperty('artifacts');
    const rendered = JSON.stringify(fanin.body);
    expect(rendered).not.toContain(secreto);
    expect(rendered).not.toContain('kratos-privado.pdf');
  });

  it('un hijo directo del mismo tenant conserva su texto y sus adjuntos', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(repository, argos);
    await ackWith(repository, argos, root, { messages: [{ to: 'socrates', body: 'rama propia' }], reply: null });
    await ackWithSecret(socrates, await nextDelivery(repository, socrates));

    const fanin = await drainUntilFanin(argos, [socrates]);
    const [branch] = responsesOf(fanin);
    expect(branch?.untrusted_text).toBe(`socrates: ${secreto}`);
    expect(branch?.artifacts).toEqual([expect.objectContaining({ name: 'socrates-privado.pdf' })]);
  });
});

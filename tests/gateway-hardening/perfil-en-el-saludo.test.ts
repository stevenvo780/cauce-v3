import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { capabilities, capabilityStrings } from '@cauce/adapter-sdk';
import { WsOutboundSchema, type WsOutbound } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { closeGatewaysAndSockets, fakeRepository, noDeliveryWakes, text } from './helpers.js';

/**
 * Verifies the inclusion of the agent profile in the `hello_ack` frame, validating schema
 * compatibility and the gating through the `agent_profile_v1` capability.
 */

describe('el esquema del saludo acepta el perfil sin romper a quien no lo espera', () => {
  const saludoBase = {
    type: 'hello_ack' as const,
    version: '3.0' as const,
    epoch: 1,
    lease_expires_at: '2026-08-25T12:00:00.000Z'
  };

  it('un saludo SIN perfil sigue siendo válido: es el de un adaptador viejo', () => {
    expect(WsOutboundSchema.safeParse(saludoBase).success).toBe(true);
  });

  it('un saludo CON perfil es válido', () => {
    const conPerfil = {
      ...saludoBase,
      agent_profile: {
        perfil: {
          tenant_id: 'Steven', alias: 'zeus',
          purpose: 'el médico de la flota', role_summary: null, human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: []
        },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [{ proveedor: 'claude', cuenta: 'saldantia' }],
          arnes: { harness: 'claude', home: '/home/dev', capacidades: ['bash'] },
          destinos: ['kant']
        }
      }
    };
    const resultado = WsOutboundSchema.safeParse(conPerfil);
    expect(resultado.success).toBe(true);
  });

  it('CONTROL NEGATIVO: un perfil a medias se RECHAZA, no se siembra medio', () => {
    /*
     * What arrives over the socket is foreign data, and with it are written files a model will
     * read as authoritative. A missing field means the two ends are not on the same version, and
     * under that condition failing the hello is better than seeding half a person.
     */
    const aMedias = {
      ...saludoBase,
      agent_profile: {
        perfil: { tenant_id: 'Steven', alias: 'zeus', purpose: 'x' },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [], arnes: { harness: 'claude', home: '/h', capacidades: [] }, destinos: []
        }
      }
    };
    expect(WsOutboundSchema.safeParse(aMedias).success).toBe(false);
  });

  it('CONTROL NEGATIVO: un campo de MÁS también se rechaza', () => {
    // `.strict()`: an unknown field is the signal that the other end speaks a different version.
    const conExtra = {
      ...saludoBase,
      agent_profile: {
        perfil: {
          tenant_id: 'Steven', alias: 'zeus',
          purpose: null, role_summary: null, human_brief: null,
          responsibilities: [], restrictions: [], tools: [], operating_rules: [],
          campo_inventado: 'x'
        },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [], arnes: { harness: 'claude', home: '/h', capacidades: [] }, destinos: []
        }
      }
    };
    expect(WsOutboundSchema.safeParse(conExtra).success).toBe(false);
  });
});

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

function profilePool(): DatabasePool {
  const result = (rows: unknown[]): { rows: unknown[]; rowCount: number } => ({ rows, rowCount: rows.length });
  return {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      const tenantId = String(values[0]);
      const alias = String(values[1]);
      if (sql.includes('FROM agent_profiles WHERE')) {
        return result([{
          tenant_id: tenantId, alias, purpose: 'operar la flota', role_summary: null,
          human_brief: null, responsibilities: ['vigilar'], restrictions: ['no desplegar'],
          tools: ['bash'], operating_rules: ['fallar cerrado'], revision: '1', applied_revision: null,
        }]);
      }
      if (sql.includes('AS ruta')) {
        return result([{ ruta: true, lectura: true, control: false, notify_rol: true }]);
      }
      if (sql.includes('FROM agent_account_bindings binding')) {
        return result([{
          provider: 'claude', account_id: 'saldantia', label: null,
          remaining_percent: '75', window_key: 'weekly',
        }]);
      }
      if (sql.includes('FROM agents agent')) {
        return result([{
          harness_id: 'codex', home_directory: '/home/dev', container_name: 'agent-midas',
          capabilities: ['bash'], enabled: true,
        }]);
      }
      if (sql.includes('FROM egress_destinations')) return result([{ total: '1' }]);
      if (sql.includes('SELECT membership.alias')) return result([{ alias: 'kant' }]);
      throw new Error(`unexpected profile query: ${sql}`);
    }),
  } as unknown as DatabasePool;
}

async function hello(
  app: Awaited<ReturnType<typeof buildGateway>>,
  alias: string,
  requestedCapabilities: readonly string[],
): Promise<WsOutbound> {
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': alias },
  });
  sockets.push(socket);
  const frame = new Promise<WsOutbound>((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error('hello_ack timed out')); }, 5_000);
    deadline.unref();
    socket.once('message', (data) => {
      clearTimeout(deadline);
      const parsed = WsOutboundSchema.safeParse(JSON.parse(text(data)));
      if (parsed.success) resolve(parsed.data);
      else reject(parsed.error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias,
    instance_id: `profile-${alias}`, capabilities: requestedCapabilities,
  }));
  return frame;
}

describe('el gateway no manda el perfil a quien no lo declaró', () => {
  it('gatea el perfil en dos saludos WebSocket reales según la capability negociada', async () => {
    const app = await buildGateway({
      pool: profilePool(),
      repository: fakeRepository(),
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });

    const capable = await hello(app, 'midas', ['agent_profile_v1']);
    expect(capable).toMatchObject({
      type: 'hello_ack',
      agent_profile: {
        perfil: {
          tenant_id: 'Pablo', alias: 'midas', purpose: 'operar la flota',
          role_summary: null, human_brief: null, responsibilities: ['vigilar'],
          restrictions: ['no desplegar'], tools: ['bash'], operating_rules: ['fallar cerrado'],
        },
        hechos: {
          permisos: { ruta: true, lectura: true, control: false, notificacion: true },
          cuotas: [{ proveedor: 'claude', cuenta: 'saldantia', limite: '75% disponible en la ventana weekly' }],
          arnes: {
            harness: 'codex', home: '/home/dev', contenedor: 'agent-midas', capacidades: ['bash'],
          },
          destinos: ['kant'],
        },
      },
    });

    const legacy = await hello(app, 'argos', []);
    expect(legacy).toMatchObject({ type: 'hello_ack' });
    expect(legacy).not.toHaveProperty('agent_profile');
  });

  it('el adaptador codifica el mismo nombre versionado en el hello', () => {
    const requested = capabilityStrings(capabilities('codex', true));
    expect(requested.filter((value) => value === 'agent_profile_v1')).toHaveLength(1);
    expect(requested).not.toContain('agent_profile');
  });
});

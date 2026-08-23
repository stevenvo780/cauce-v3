import type { FleetAgent } from './fleet';
import {
  formatCountdown,
  operatorRouteForAgent,
  ptyReasonProblem,
  ptySecondsLeft,
  terminalSessionRefusal,
  transcriptForSession,
  type OperatorSession,
} from './session';

function agent(tenantId: string, alias: string): FleetAgent {
  return {
    id: `${tenantId.toLocaleLowerCase()}:${alias.toLocaleLowerCase()}`,
    tenantId,
    alias,
    roomIds: [],
    roomMembership: {},
    leaseState: 'unknown',
  };
}

it('publishes cross-tenant only from an operator room allowed by directed ACL', () => {
  const target = agent('Miguel', 'kratos');
  const topology = {
    tenants: [
      { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'kant', enabled: true }] }] },
      { id: 'Miguel', rooms: [{ id: 'grp.miguel', members: [{ alias: 'kratos', enabled: true }] }] },
    ],
    acl_edges: [{ from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_control: true }],
  };

  expect(operatorRouteForAgent(topology, { subject: 'Steven:kant' }, target)).toMatchObject({
    allowed: true,
    sourceRoomIds: ['grp.steven'],
  });
  expect(operatorRouteForAgent({ ...topology, acl_edges: [] }, { subject: 'Steven:kant' }, target)).toMatchObject({
    allowed: false,
    sourceRoomIds: ['grp.steven'],
  });
});

it('fails closed on UNKNOWN membership and does not borrow the recipient room', () => {
  const route = operatorRouteForAgent({
    tenants: [
      { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'kant' }] }] },
      { id: 'Miguel', rooms: [{ id: 'grp.miguel', members: [{ alias: 'kratos', enabled: true }] }] },
    ],
    acl_edges: [{ from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_control: true }],
  }, { subject: 'Steven:kant' }, agent('Miguel', 'kratos'));

  expect(route.allowed).toBe(false);
  expect(route.membership).toBeUndefined();
  expect(route.sourceRoomIds).not.toContain('grp.miguel');
  expect(route.reason).toMatch(/UNKNOWN/);
});

it('projects a recipient transcript across server-authorized rooms', () => {
  const target = agent('Miguel', 'kratos');
  const session: OperatorSession = {
    id: 'session:miguel:kratos', agent: target, sourceRoomId: 'grp.steven', openedAt: '', mode: 'transcript',
  };
  const items = transcriptForSession({ items: [
    {
      message_id: 'input', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      deliveries: [{ delivery_id: 'delivery', recipient_tenant: 'Miguel', recipient_alias: 'kratos' }],
    },
    { message_id: 'output', tenant_id: 'Miguel', room_id: 'grp.miguel', actor_alias: 'kratos' },
    { message_id: 'other', tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva' },
  ] }, session);

  expect(items.map((item) => [item.message.message_id, item.direction])).toEqual([
    ['input', 'input'],
    ['output', 'output'],
  ]);
});

it('demands a hand-written justification between 8 and 280 characters', () => {
  expect(ptyReasonProblem('')).toMatch(/al menos 8/);
  expect(ptyReasonProblem('corto')).toMatch(/al menos 8/);
  // Whitespace is not a justification: it is trimmed before counting.
  expect(ptyReasonProblem('        ')).toMatch(/al menos 8/);
  expect(ptyReasonProblem('revisar el bucle de argos')).toBeUndefined();
  expect(ptyReasonProblem('x'.repeat(281))).toMatch(/no puede pasar de 280/);
});

it('counts down to the grant expiry and shows UNKNOWN instead of a fake clock', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  expect(ptySecondsLeft('2026-07-25T12:00:30.000Z', now)).toBe(30);
  expect(ptySecondsLeft('2026-07-25T11:59:00.000Z', now)).toBe(0);
  expect(ptySecondsLeft(undefined, now)).toBeUndefined();
  expect(ptySecondsLeft('no es una fecha', now)).toBeUndefined();
  expect(formatCountdown(ptySecondsLeft(null, now))).toBe('UNKNOWN');
  expect(formatCountdown(95)).toBe('1:35');
  expect(formatCountdown(5)).toBe('0:05');
});


/**
 * La traducción del rechazo, sin navegador de por medio. El caso que la hizo nacer: un 403 cuyo
 * mensaje dice «se requiere un token CSRF válido» NO es una falta de permiso del operador.
 */
describe('terminalSessionRefusal', () => {
  class Fallo extends Error {
    constructor(mensaje: string, readonly status: number, readonly code?: string) { super(mensaje); }
  }

  it('llama al fallo de CSRF por su nombre y lo atribuye a la consola', () => {
    const refusal = terminalSessionRefusal(new Fallo('se requiere un token CSRF válido', 403, 'forbidden'));
    expect(refusal.esDefectoDeLaConsola).toBe(true);
    expect(refusal.detalle).toMatch(/falta el token CSRF/i);
    expect(refusal.detalle).toMatch(/no de tu permiso ni del alias/i);
    expect(refusal.detalle).toMatch(/quien mantiene la consola/i);
  });

  it('un 403 cualquiera repite el motivo del servidor y NO acusa a la consola', () => {
    const refusal = terminalSessionRefusal(new Fallo('attribution_required', 403, 'forbidden'));
    expect(refusal.esDefectoDeLaConsola).toBe(false);
    expect(refusal.detalle).toContain('attribution_required');
    expect(refusal.detalle).toContain('403');
  });

  it('distingue el 409 del destino y el 401 de la sesión', () => {
    expect(terminalSessionRefusal(new Fallo('agent_offline', 409, 'conflict')).detalle).toMatch(/409.*agent_offline/);
    expect(terminalSessionRefusal(new Fallo('unauthorized', 401)).detalle).toMatch(/caducó|401/i);
  });

  it('un error sin status no inventa una causa: dice lo que sabe', () => {
    const refusal = terminalSessionRefusal(new Error('Failed to fetch'));
    expect(refusal.esDefectoDeLaConsola).toBe(false);
    expect(refusal.detalle).toContain('Failed to fetch');
    expect(refusal.titulo).toBe('No se pudo abrir el canal');
  });
});

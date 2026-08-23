import type { FleetAgent } from './fleet';
import {
  formatCountdown,
  operatorRouteForAgent,
  ptyReasonProblem,
  ptySecondsLeft,
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

it('falla cerrado cuando no se pudo leer la membresía, y no toma prestada la sala del destinatario', () => {
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
  expect(route.reason).toMatch(/no se pudo comprobar la membresía/i);
  // Y sigue sin llevar la palabra en inglés a la pantalla.
  expect(route.reason).not.toContain('UNKNOWN');
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

it('cuenta atrás hasta el vencimiento del permiso y dice «sin dato» en vez de un reloj inventado', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  expect(ptySecondsLeft('2026-07-25T12:00:30.000Z', now)).toBe(30);
  expect(ptySecondsLeft('2026-07-25T11:59:00.000Z', now)).toBe(0);
  expect(ptySecondsLeft(undefined, now)).toBeUndefined();
  expect(ptySecondsLeft('no es una fecha', now)).toBeUndefined();
  expect(formatCountdown(ptySecondsLeft(null, now))).toBe('sin dato');
  expect(formatCountdown(95)).toBe('1:35');
  expect(formatCountdown(5)).toBe('0:05');
});


